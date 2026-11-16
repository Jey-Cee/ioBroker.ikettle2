'use strict';

/**
 * Helpers for the Smarter iKettle 2.0 binary protocol (TCP port 2081).
 * Every message is `<id> <args...> 0x7e`.
 */

const TERMINATOR = 0x7e;
const MSG_STATUS = 0x14;

/**
 * Collects TCP chunks and returns complete messages. TCP does not keep message
 * boundaries, so one chunk can hold several messages or only a part of one.
 */
class FrameParser {
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

	reset() {
		this.buffer = Buffer.alloc(0);
	}
}

/**
 * Decodes a status message `0x14 <status> <temp> <wlevel hi> <wlevel lo> <unknown> 0x7e`.
 * The high byte of the water sensor is 8 while the kettle is on the base (7 when off).
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
		onBase: frame[3] === 0x08,
	};
}

/**
 * Converts the raw water sensor value to litres with a two-point calibration.
 *
 * @param {number} raw - raw sensor value
 * @param {{lowRaw: number, lowLiters: number, highRaw: number, highLiters: number}} cal - calibration points
 * @returns {number | null} litres (one decimal, not below 0) or null if the calibration is unusable
 */
function litersFromRaw(raw, cal) {
	const lowRaw = Number(cal.lowRaw);
	const highRaw = Number(cal.highRaw);
	const lowLiters = Number(cal.lowLiters);
	const highLiters = Number(cal.highLiters);
	if (![lowRaw, highRaw, lowLiters, highLiters].every(Number.isFinite) || highRaw === lowRaw) {
		return null;
	}
	const liters = lowLiters + ((raw - lowRaw) * (highLiters - lowLiters)) / (highRaw - lowRaw);
	return Math.max(0, Math.round(liters * 10) / 10);
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

module.exports = { FrameParser, parseStatus, litersFromRaw, median, TERMINATOR, MSG_STATUS };
