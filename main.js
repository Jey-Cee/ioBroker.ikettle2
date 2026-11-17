'use strict';

/*
 * Created with @iobroker/create-adapter v1.33.0
 */

const utils = require('@iobroker/adapter-core');
const net = require('node:net');
const { FrameParser, parseStatus, litersFromRaw, calibrationPoints, median, MSG_STATUS } = require('./lib/protocol');

const PORT = 2081;
const RESPONSE_TIMEOUT = 5000; // ms to wait for the answer to a command
const DATA_TIMEOUT = 60000; // the kettle sends a status every ~2 s; reconnect after this much silence
const RECONNECT_MIN = 5000;
const RECONNECT_MAX = 60000;
const RAW_SAMPLES = 5; // median over the last raw values
const LEVEL_SAMPLES = 7; // median over the last values taken while the kettle is idle and cold
const SETTLE_TIME = 10000; // the sensor jumps when heating starts: drop values this close before it

const MSG_ACK = 0x03;
const MSG_CALIBRATED = 0x2d;
const MSG_PRESET = 0x2f;
const MSG_DEVICE_INFO = 0x65;

class Ikettle2 extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - options object
	 */
	constructor(options) {
		super({
			...options,
			name: 'ikettle2',
		});

		/** @type {net.Socket | null} */
		this.client = null;
		this.connected = false;
		this.unloading = false;
		this.parser = new FrameParser();
		/** @type {ioBroker.Timeout | undefined} */
		this.reconnectTimer = undefined;
		this.reconnectDelay = RECONNECT_MIN;
		this.lastErrorCode = '';
		/** @type {((frame: Buffer | null) => void) | null} */
		this.pendingResponse = null;
		/** @type {Promise<unknown>} */
		this.commandQueue = Promise.resolve();

		/** @type {number[]} */
		this.rawSamples = [];
		/** @type {{ts: number, raw: number}[]} */
		this.levelSamples = [];
		/** @type {number[]} */
		this.tempSamples = [];
		this.lastStatus = 0;

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		await this.setState('info.connection', { val: false, ack: true });

		this.subscribeStates('kettle.on');
		this.subscribeStates('kettle.on_formula');
		this.subscribeStates('kettle.calibrate');
		this.subscribeStates('kettle.preset.set_preset');
		this.subscribeStates('kettle.preset.get_preset');

		if (!this.config.ip) {
			this.log.warn('No ip set in configuration! Please set the ip for the iKettle');
			return;
		}
		this.connect();
	}

	/**
	 * Opens the TCP connection. All reconnects go through scheduleReconnect() with a growing delay.
	 */
	connect() {
		if (this.unloading) {
			return;
		}
		this.parser.reset();
		const socket = new net.Socket();
		this.client = socket;
		socket.setKeepAlive(true, 10000);
		socket.setTimeout(DATA_TIMEOUT);

		socket.on('connect', async () => {
			this.connected = true;
			this.reconnectDelay = RECONNECT_MIN;
			this.lastErrorCode = '';
			this.log.info(`Connected to iKettle at ${this.config.ip}`);
			await this.setState('info.connection', { val: true, ack: true });
			await this.getDeviceInfo();
			await this.getPreset();
		});

		socket.on('data', data => {
			for (const frame of this.parser.push(Buffer.isBuffer(data) ? data : Buffer.from(data))) {
				this.handleFrame(frame).catch(e => this.log.error(`Cannot handle message: ${e}`));
			}
		});

		socket.on('timeout', () => {
			this.log.warn(`No data from the iKettle for ${DATA_TIMEOUT / 1000} s, reconnecting`);
			socket.destroy();
		});

		socket.on('error', error => {
			const code = /** @type {NodeJS.ErrnoException} */ (error).code || error.message;
			if (code !== this.lastErrorCode) {
				this.log.warn(`Connection error: ${code}`);
				this.lastErrorCode = code;
			} else {
				this.log.debug(`Connection error: ${code}`);
			}
		});

		socket.on('close', async () => {
			if (this.client !== socket) {
				return;
			}
			if (this.connected) {
				this.log.info('Connection to the iKettle closed');
			}
			this.connected = false;
			this.client = null;
			if (this.pendingResponse) {
				this.pendingResponse(null);
			}
			if (!this.unloading) {
				await this.setState('info.connection', { val: false, ack: true });
				this.scheduleReconnect();
			}
		});

		socket.connect({ port: PORT, host: this.config.ip });
	}

	scheduleReconnect() {
		if (this.unloading || this.reconnectTimer) {
			return;
		}
		this.log.debug(`Reconnecting in ${this.reconnectDelay / 1000} s`);
		this.reconnectTimer = this.setTimeout(() => {
			this.reconnectTimer = undefined;
			this.connect();
		}, this.reconnectDelay);
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param {() => void} callback - callback function to indicate completion
	 */
	async onUnload(callback) {
		this.unloading = true;
		try {
			if (this.reconnectTimer) {
				this.clearTimeout(this.reconnectTimer);
				this.reconnectTimer = undefined;
			}
			if (this.client) {
				this.client.destroy();
				this.client = null;
			}
			await this.setState('info.connection', { val: false, ack: true });
		} catch {
			// ignore
		}
		callback();
	}

	/**
	 * @param {Buffer} frame - one complete message from the kettle
	 */
	async handleFrame(frame) {
		if (frame[0] === MSG_STATUS) {
			await this.decodeStatus(frame);
		} else if (this.pendingResponse) {
			this.pendingResponse(frame);
		} else {
			this.log.debug(`Unexpected message: ${frame.toString('hex')}`);
		}
	}

	/**
	 * Sends a command and waits for its answer. Status messages are not taken as answers.
	 * Commands are sent one after another.
	 *
	 * @param {number[]} bytes - the command including the terminator
	 * @param {string} name - name for log messages
	 * @returns {Promise<Buffer | null>} the answer or null
	 */
	sendCommand(bytes, name) {
		const run = () =>
			new Promise(resolve => {
				if (!this.client || !this.connected) {
					this.log.warn(`${name}: iKettle is not connected`);
					resolve(null);
					return;
				}
				const timer = this.setTimeout(() => {
					this.pendingResponse = null;
					this.log.warn(`${name}: no answer from the iKettle`);
					resolve(null);
				}, RESPONSE_TIMEOUT);
				this.pendingResponse = frame => {
					this.clearTimeout(timer);
					this.pendingResponse = null;
					resolve(frame);
				};
				this.log.debug(`${name}: send ${Buffer.from(bytes).toString('hex')}`);
				this.client.write(Buffer.from(bytes));
			});
		const result = this.commandQueue.then(run, run);
		this.commandQueue = result;
		return /** @type {Promise<Buffer | null>} */ (result);
	}

	/**
	 * Checks a `0x03 <code>` answer.
	 *
	 * @param {Buffer | null} response - answer of the kettle
	 * @param {string} command - name for log messages
	 * @returns {boolean} true if the kettle accepted the command
	 */
	isAccepted(response, command) {
		if (!response) {
			return false;
		}
		if (response[0] === MSG_ACK && response[1] === 0) {
			return true;
		}
		this.logError(response, command);
		return false;
	}

	/**
	 * Is called if a subscribed state changes
	 *
	 * @param {string} id - id of the state that changed
	 * @param {ioBroker.State | null | undefined} state - the state that changed
	 */
	async onStateChange(id, state) {
		if (!state || state.ack) {
			return;
		}
		this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
		switch (id) {
			case `${this.namespace}.kettle.calibrate`:
				if (state.val) {
					await this.calibrate();
				}
				await this.setState('kettle.calibrate', { val: false, ack: true });
				break;
			case `${this.namespace}.kettle.on`:
				if (state.val) {
					await this.switchOn();
				} else {
					await this.switchOff();
				}
				break;
			case `${this.namespace}.kettle.on_formula`:
				if (state.val) {
					await this.switchOnFormula();
				} else {
					await this.switchOff();
				}
				break;
			case `${this.namespace}.kettle.preset.set_preset`:
				if (state.val) {
					await this.setPreset();
				}
				await this.setState('kettle.preset.set_preset', { val: false, ack: true });
				break;
			case `${this.namespace}.kettle.preset.get_preset`:
				if (state.val) {
					await this.getPreset();
				}
				await this.setState('kettle.preset.get_preset', { val: false, ack: true });
				break;
		}
	}

	/**
	 * @param {Buffer} data - status message
	 */
	async decodeStatus(data) {
		const status = parseStatus(data);
		if (!status) {
			return;
		}
		const now = Date.now();
		const on = status.status === 0x01;

		await this.setStateChangedAsync('kettle.on_plate', { val: status.onBase, ack: true });

		if (!status.onBase) {
			// the kettle was lifted, probably to refill it: old level values are useless now
			this.rawSamples = [];
			this.levelSamples = [];
		} else {
			this.tempSamples.push(status.temperature);
			if (this.tempSamples.length > 3) {
				this.tempSamples.shift();
			}
			const temperature = Math.round(this.tempSamples.reduce((a, b) => a + b, 0) / this.tempSamples.length);
			await this.setStateChangedAsync('kettle.water_temperature', { val: temperature, ack: true });

			this.rawSamples.push(status.raw);
			if (this.rawSamples.length > RAW_SAMPLES) {
				this.rawSamples.shift();
			}
			await this.setStateChangedAsync('kettle.water_level_raw', {
				val: median(this.rawSamples),
				ack: true,
			});

			if (status.status !== 0 && this.lastStatus === 0) {
				// heating started: the sensor jumped already, keep only older values
				this.levelSamples = this.levelSamples.filter(s => s.ts < now - SETTLE_TIME);
				await this.updateWaterLevel();
			}
			const hotTemperature = Number(this.config.hotTemperature) || 40;
			// the weight sensor drifts with heat, so the level is only measured while idle and cold
			if (status.status === 0 && temperature < hotTemperature) {
				this.levelSamples.push({ ts: now, raw: status.raw });
				if (this.levelSamples.length > LEVEL_SAMPLES) {
					this.levelSamples.shift();
				}
				await this.updateWaterLevel();
			}
		}
		this.lastStatus = status.status;

		await this.setStateChangedAsync('kettle.on', { val: on, ack: true });
		await this.setStateChangedAsync('kettle.on_formula', { val: on, ack: true });
	}

	async updateWaterLevel() {
		const raw = median(this.levelSamples.map(s => s.raw));
		if (raw === null) {
			return;
		}
		const liters = litersFromRaw(raw, calibrationPoints(this.config));
		if (liters === null) {
			this.log.warn('Water level calibration in the instance settings is invalid');
			return;
		}
		await this.setStateChangedAsync('kettle.water_level', { val: liters, ack: true });
	}

	async calibrate() {
		const response = await this.sendCommand([0x2c, 0x7e], 'Calibrate iKettle water level');
		if (!response) {
			return;
		}
		if (response[0] === MSG_CALIBRATED || (response[0] === MSG_ACK && response[1] === 0)) {
			this.log.info('Base calibration done');
		} else {
			this.logError(response, 'Calibrate iKettle water level');
		}
	}

	/**
	 * @param {ioBroker.State | null | undefined} state - state with a number
	 * @param {number} min - lowest allowed value
	 * @param {number} max - highest allowed value
	 * @returns {number | null} the value or null if it is missing or out of range
	 */
	numberInRange(state, min, max) {
		const val = state ? Number(state.val) : NaN;
		return Number.isInteger(val) && val >= min && val <= max ? val : null;
	}

	async switchOn() {
		const temp = this.numberInRange(await this.getStateAsync('kettle.set_temperature'), 1, 100);
		if (temp === null) {
			this.log.warn('Set kettle.set_temperature (1-100 °C) before switching the kettle on');
			await this.setState('kettle.on', { val: false, ack: true });
			return;
		}
		const response = await this.sendCommand([0x15, temp, 0x00, 0x7e], 'Switch iKettle ON');
		if (this.isAccepted(response, 'Switch iKettle ON')) {
			await this.setState('kettle.on', { val: true, ack: true });
			await this.setState('kettle.set_temperature', { val: temp, ack: true });
		} else {
			await this.setState('kettle.on', { val: false, ack: true });
		}
	}

	async switchOnFormula() {
		const temp = this.numberInRange(await this.getStateAsync('kettle.formula_temperature'), 1, 100);
		const time = this.numberInRange(await this.getStateAsync('kettle.warming_time'), 0, 30);
		if (temp === null) {
			this.log.warn('Set kettle.formula_temperature (1-100 °C) before switching the kettle on');
			await this.setState('kettle.on_formula', { val: false, ack: true });
			return;
		}
		if (time === null || (time < 5 && time !== 0)) {
			this.log.warn('Warming time must be 0 or 5-30 minutes');
			await this.setState('kettle.on_formula', { val: false, ack: true });
			return;
		}

		const response = await this.sendCommand([0x19, temp, time, 0x7e], 'Switch iKettle ON formula');
		if (this.isAccepted(response, 'Switch iKettle ON formula')) {
			await this.setState('kettle.on_formula', { val: true, ack: true });
			await this.setState('kettle.formula_temperature', { val: temp, ack: true });
			await this.setState('kettle.warming_time', { val: time, ack: true });
		} else {
			await this.setState('kettle.on_formula', { val: false, ack: true });
		}
	}

	async switchOff() {
		const response = await this.sendCommand([0x16, 0x7e], 'Switch iKettle OFF');
		if (this.isAccepted(response, 'Switch iKettle OFF')) {
			await this.setState('kettle.on', { val: false, ack: true });
			await this.setState('kettle.on_formula', { val: false, ack: true });
		}
	}

	async setPreset() {
		const temp = this.numberInRange(await this.getStateAsync('kettle.preset.temperature'), 1, 100);
		const formulaTemp = this.numberInRange(await this.getStateAsync('kettle.preset.formula_temperature'), 0, 100);
		const warmingTime = this.numberInRange(await this.getStateAsync('kettle.preset.warming_time'), 0, 30);
		if (temp === null || formulaTemp === null) {
			this.log.warn('Preset temperatures must be set (1-100 °C) before sending them');
			return;
		}
		if (warmingTime === null || (warmingTime < 5 && warmingTime !== 0)) {
			this.log.warn('Warming time must be 0 or 5-30 minutes');
			return;
		}

		const response = await this.sendCommand(
			[0x1f, warmingTime, temp, formulaTemp, 0x7e],
			'Set presets for manual control',
		);
		if (this.isAccepted(response, 'Set presets for manual control')) {
			await this.setState('kettle.preset.temperature', { val: temp, ack: true });
			await this.setState('kettle.preset.formula_temperature', { val: formulaTemp, ack: true });
			await this.setState('kettle.preset.warming_time', { val: warmingTime, ack: true });
		}
	}

	async getPreset() {
		const response = await this.sendCommand([0x2e, 0x7e], 'Get presets');
		if (response && response[0] === MSG_PRESET && response.length >= 5) {
			await this.setState('kettle.preset.temperature', { val: response[1], ack: true });
			await this.setState('kettle.preset.warming_time', { val: response[2], ack: true });
			await this.setState('kettle.preset.formula_temperature', { val: response[3], ack: true });
		} else if (response) {
			this.logError(response, 'Get presets');
		}
	}

	async getDeviceInfo() {
		const response = await this.sendCommand([0x64, 0x7e], 'Get device info');
		if (response && response[0] === MSG_DEVICE_INFO && response.length >= 4) {
			await this.extendObjectAsync('kettle', {
				native: {
					firmwareVersion: response[2],
				},
			});
		} else if (response) {
			this.logError(response, 'Get device info');
		}
	}

	/**
	 * @param {Buffer} response - unexpected answer of the kettle
	 * @param {string} command - name for log messages
	 */
	logError(response, command) {
		/** @type {Record<number, string>} */
		const errorMessage = {
			0x01: 'Busy and can not execute',
			0x04: 'Command failed:',
		};
		if (response[0] === MSG_ACK && errorMessage[response[1]]) {
			this.log.error(`${errorMessage[response[1]]} ${command}`);
		} else {
			this.log.error(`${command}: unexpected answer ${response.toString('hex')}`);
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - options object
	 */
	module.exports = options => new Ikettle2(options);
} else {
	// otherwise start the instance directly
	new Ikettle2();
}
