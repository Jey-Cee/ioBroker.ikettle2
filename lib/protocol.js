'use strict';

/**
 * Helpers for the Smarter iKettle 2.0 binary protocol (TCP port 2081).
 * Every message is `<id> <args...> 0x7e`.
 */

const TERMINATOR = 0x7e;
const MSG_STATUS = 0x14;
const TEMP_OFF_BASE = 0x7f;

/**
 * Collects TCP chunks and returns complete messages. TCP does not keep message
 * boundaries, so one chunk can hold several messages or only a part of one.
 */
class FrameParser {
	/**
	 * Starts with an empty buffer.
	 */
	constructor() {
		/** @type {Buffer} */
		this.buffer = Buffer.alloc(0);
	}

	/**
	 * @param {Buffer} chunk - received data
	 * @returns {Buffer[]} complete messages including the terminator
	 */
	push(chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		const frames = [];
		let end;
		while ((end = this.buffer.indexOf(TERMINATOR)) >= 0) {
			const frame = this.buffer.subarray(0, end + 1);
			this.buffer = this.buffer.subarray(end + 1);
			if (frame.length > 1) {
				frames.push(Buffer.from(frame));
			}
		}
		// never keep garbage forever if a terminator is lost
		if (this.buffer.length > 256) {
			this.buffer = Buffer.alloc(0);
		}
		return frames;
	}

	/**
	 * Drops a partly received message, e.g. after a reconnect.
	 */
	reset() {
		this.buffer = Buffer.alloc(0);
	}
}

/**
 * Decodes a status message `0x14 <status> <temp> <wlevel hi> <wlevel lo> <unknown> 0x7e`.
 * The high byte of the water sensor is 8 while the kettle is on the base (7 when off).
 * Without the kettle the temperature is reported as 127 (0x7f), also in single messages
 * whose sensor value already looks like "on the base" while the kettle is put back.
 *
 * @param {Buffer} frame - one complete message
 * @returns {{status: number, temperature: number, raw: number, onBase: boolean} | null} decoded status or null
 */
function parseStatus(frame) {
	if (frame.length < 6 || frame[0] !== MSG_STATUS) {
		return null;
	}
	return {
		status: frame[1],
		temperature: frame[2],
		raw: frame.readUInt16BE(3),
		onBase: frame[3] === 0x08 && frame[2] !== TEMP_OFF_BASE,
	};
}

/**
 * Converts the raw water sensor value to litres. The calibration points are joined by straight
 * lines (the sensor of the iKettle 2.0 is not linear: the first litre moves it more than the
 * following ones). Below the first and above the last point the nearest line is extended.
 *
 * @param {number} raw - raw sensor value
 * @param {{raw: number, liters: number}[]} points - at least two calibration points
 * @returns {number | null} litres (one decimal, not below 0) or null if the calibration is unusable
 */
function litersFromRaw(raw, points) {
	const sorted = points.map(p => ({ raw: Number(p.raw), liters: Number(p.liters) })).sort((a, b) => a.raw - b.raw);
	if (sorted.length < 2 || !sorted.every(p => Number.isFinite(p.raw) && Number.isFinite(p.liters))) {
		return null;
	}
	for (let i = 1; i < sorted.length; i++) {
		// more water must always give a higher raw value
		if (sorted[i].raw === sorted[i - 1].raw || sorted[i].liters <= sorted[i - 1].liters) {
			return null;
		}
	}
	let i = 1;
	while (i < sorted.length - 1 && raw > sorted[i].raw) {
		i++;
	}
	const a = sorted[i - 1];
	const b = sorted[i];
	const liters = a.liters + ((raw - a.raw) * (b.liters - a.liters)) / (b.raw - a.raw);
	return Math.max(0, Math.round(liters * 10) / 10);
}

/**
 * Builds the calibration points from the instance settings. The empty point is optional
 * (raw value 0 = not used).
 *
 * @param {{levelEmptyRaw?: number, levelLowRaw: number, levelLowLiters: number, levelHighRaw: number, levelHighLiters: number}} config - instance settings
 * @returns {{raw: number, liters: number}[]} calibration points
 */
function calibrationPoints(config) {
	const points = [
		{ raw: config.levelLowRaw, liters: config.levelLowLiters },
		{ raw: config.levelHighRaw, liters: config.levelHighLiters },
	];
	if (Number(config.levelEmptyRaw) > 0) {
		points.unshift({ raw: Number(config.levelEmptyRaw), liters: 0 });
	}
	return points;
}

/**
 * @param {number[]} values - numbers
 * @returns {number | null} median or null for an empty list
 */
function median(values) {
	if (!values.length) {
		return null;
	}
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

module.exports = { FrameParser, parseStatus, litersFromRaw, calibrationPoints, median, TERMINATOR, MSG_STATUS };
