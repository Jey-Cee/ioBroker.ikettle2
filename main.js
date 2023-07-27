'use strict';

/*
 * Created with @iobroker/create-adapter v1.33.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
// const fs = require("fs");

const socket = require('net');

let client, lastWaterLevel = [], lastWaterTemp = [], lastDataReceived = null;

class Ikettle2 extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: 'ikettle2',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		// this.on('objectChange', this.onObjectChange.bind(this));
		// this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		this.subscribeStates('kettle.on');
		this.subscribeStates('kettle.on_formula');
		this.subscribeStates('kettle.calibrate');
		this.subscribeStates('kettle.preset.set_preset');

		client = new socket.Socket();

		client.connect({port: 2081, host: this.config.ip});

		client.on('ready', async () => {
			await this.setStateAsync(`${this.namespace}.info.connection`, {val: true, ack: true});
			await this.getDeviceInfo();
			await this.getPreset();
		});

		client.on('data', async (data) => {

			switch(data[0]) {
				case 0x14:
					await this.decodeStatus(data);
					/*if(data[4] > 200){
						await this.calibrate();
					}*/
					break;
			}

			clearTimeout(lastDataReceived);
			lastDataReceived = setTimeout( () => {
				client.destroy();
				client.connect({port: 2081, host: this.config.ip});
			}, 120000);
		});

		client.on('timeout', async () => {
			await this.setStateAsync(`${this.namespace}.info.connection`, {val: false, ack: true});
			client.destroy();
			client.connect({port: 2081, host: this.config.ip});
		});

		client.on('error', async (error) => {
			this.log.error(JSON.stringify(error));
			client.destroy();
			client.connect({port: 2081, host: this.config.ip});
			await this.setStateAsync(`${this.namespace}.info.connection`, {val: false, ack: true});
		});

		client.on('close', async () => {
			this.log.info('Connection closed by remote host');
			await this.setStateAsync(`${this.namespace}.info.connection`, {val: false, ack: true});
		});

		client.on('end', async () => {
			this.log.info('Connection ended by remote host');
			await this.setStateAsync(`${this.namespace}.info.connection`, {val: false, ack: true});
		});
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	async onUnload(callback) {
		try {
			await this.setStateAsync(`${this.namespace}.info.connection`, {val: false, ack: true});
			client.end( () => {
				callback();
			});

		} catch (e) {
			callback();
		}
	}

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	async onStateChange(id, state) {
		if (state && state.ack === false) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
			switch (id){
				case `${this.namespace}.kettle.calibrate`:
					await this.setStateAsync(`${this.namespace}.kettle.calibrate`, {val: state.val, ack: true});
					if(state.val) {
						await this.calibrate();
					}
					break;
				case `${this.namespace}.kettle.on`:
					await this.setStateAsync(`${this.namespace}.kettle.on`, {val: state.val, ack: true});
					if(state.val) {
						await this.switchOn();
					} else {
						await this.switchOff();
					}
					break;
				case `${this.namespace}.kettle.on_formula`:
					await this.setStateAsync(`${this.namespace}.kettle.on_formula`, {val: state.val, ack: true});
					if(state.val) {
						await this.switchOnFormula();
					} else {
						await this.switchOff();
					}
					break;
				case `${this.namespace}.kettle.preset.set_preset`:
					await this.setStateAsync(`${this.namespace}.kettle.preset.set_preset`, {val: state.val, ack: true});
					if(state.val){
						await this.setPreset();
					}
					break;
				case `${this.namespace}.kettle.preset.get_preset`:
					if(state.val){
						await this.getPreset();
					}
					break;
			}
		} else {
			// The state was deleted
			//this.log.info(`state ${id} deleted`);
		}
	}


	async decodeStatus(data){
		let on = false, kettle = false, level = 0;
		if(data[1] === 0x01){
			on = true;
		}
		if(data[3] === 0x08){
			kettle = true;
		}

		let raw = data.slice(3, 5);
		raw = parseInt(raw.toString('hex'), 16);

		if(raw >= 2090) {
			if (lastWaterLevel.length < 5) {
				lastWaterLevel.push(raw);
			} else {
				const val = (lastWaterLevel[0] + lastWaterLevel[1] + lastWaterLevel[2] + lastWaterLevel[3] + lastWaterLevel[4]) / 5;
				const min = 2090, max = 2185, liter = 1.8;
				level = (liter / (max - min)) * (val - min);
				let result = Math.round(parseFloat(level.toFixed(1)) * 100) / 100;
				await this.setStateChangedAsync(`${this.namespace}.kettle.water_level`, {val: result, ack: true});
				lastWaterLevel.splice(4, 1);
				lastWaterLevel.splice(0, 0, raw);
			}
		}

		if(lastWaterTemp.length < 3){
			lastWaterTemp.push(data[2]);
		} else {
			const val = (lastWaterTemp[0] + lastWaterTemp[1] + lastWaterTemp[2]) / 3;
			const result = Math.round(parseFloat(val.toFixed(0)) * 100) / 100;
			await this.setStateChangedAsync(`${this.namespace}.kettle.water_temperature`, {val: result, ack: true});
			lastWaterTemp.splice(2, 1);
			lastWaterTemp.splice(0, 0, data[2]);
		}

		await this.setStateChangedAsync(`${this.namespace}.kettle.on`, {val: on, ack: true});
		await this.setStateChangedAsync(`${this.namespace}.kettle.on_formula`, {val: on, ack: true});
		await this.setStateChangedAsync(`${this.namespace}.kettle.on_plate`, {val: kettle, ack: true});

	}

	async calibrate(){
		const msg = Buffer.from([0x2c, 0x7e]);
		client.write(msg);
		const response = await this.waitForResponse();
		if(response[1] === 0) {
			await this.setStateAsync(`${this.namespace}.kettle.calibrate`, {val: false, ack: true});
		} else {
			await this.logError(response[1], 'Calibrate iKettle water level');
		}
	}

	async switchOn(){
		const temp = await this.getStateAsync(`${this.namespace}.kettle.set_temperature`);
		const msg = Buffer.from([0x15, '0x' + temp.val.toString(16), 0x00, 0x7e]);
		client.write(msg);
		const response = await this.waitForResponse();
		if(response[1] === 0) {
			await this.setStateAsync(`${this.namespace}.kettle.on`, {val: true, ack: true});
			await this.setStateAsync(`${this.namespace}.kettle.set_temperature`, {val: temp.val, ack: true});
		} else {
			await this.logError(response[1], 'Switch iKettle ON');
		}
	}

	async switchOnFormula(){
		const temp = await this.getStateAsync(`${this.namespace}.kettle.formula_temperature`);
		const time = await this.getStateAsync(`${this.namespace}.kettle.warming_time`);
		if(time.val < 5 && time.val !== 0){
			this.log.warn('Minimum warming time 5 minutes');
			return;
		}
		if(time.val > 30){
			this.log.warn('Maximum warming time 30 minutes');
			return;
		}

		const msg = Buffer.from([0x19, '0x' + temp.val.toString(16), '0x' + time.val.toString(16), 0x7e]);
		console.log(msg);
		client.write(msg);
		const response = await this.waitForResponse();
		if(response[1] === 0) {
			await this.setStateAsync(`${this.namespace}.kettle.on_formula`, {val: true, ack: true});
			await this.setStateAsync(`${this.namespace}.kettle.formula_temperature`, {val: temp.val, ack: true});
			await this.setStateAsync(`${this.namespace}.kettle.warming_time`, {val: time.val, ack: true});
		} else {
			await this.logError(response[1], 'Switch iKettle ON formula');
		}
	}

	async switchOff(){
		const msg = Buffer.from([0x16, 0x7e]);
		client.write(msg);
		const response = await this.waitForResponse();
		if(response[1] === 0) {
			await this.setStateAsync(`${this.namespace}.kettle.on`, {val: false, ack: true});
		} else {
			await this.logError(response[1], 'Switch iKettle OFF');
		}
	}

	async setPreset(){
		const temp = await this.getStateAsync(`${this.namespace}.kettle.preset.temperature`);
		const formulaTemp = await this.getStateAsync(`${this.namespace}.kettle.preset.formula_temperature`);
		const warmingTime = await this.getStateAsync(`${this.namespace}.kettle.preset.warming_time`);
		const msg = Buffer.from([0x1f, '0x' + warmingTime.val.toString(16), '0x' + temp.val.toString(16), '0x' + formulaTemp.val.toString(16), 0x7e]);

		if(warmingTime.val < 5 && warmingTime.val !== 0){
			this.log.warn('Minimum warming time 5 minutes');
			return;
		}
		if(warmingTime.val > 30){
			this.log.warn('Maximum warming time 30 minutes');
			return;
		}

		client.write(msg);
		const response = await this.waitForResponse();
		if(response[1] === 0) {
			await this.setStateAsync(`${this.namespace}.kettle.preset.set_preset`, {val: false, ack: true});
			await this.setStateAsync(`${this.namespace}.kettle.preset.temperature`, {val: temp.val, ack: true});
			await this.setStateAsync(`${this.namespace}.kettle.preset.formula_temperature`, {val: formulaTemp.val, ack: true});
			await this.setStateAsync(`${this.namespace}.kettle.preset.warming_time`, {val: warmingTime.val, ack: true});
		} else {
			await this.logError(response[1], 'Set presets for manual control');
		}
	}

	async getPreset(){
		const msg = Buffer.from([0x2e, 0x7e]);
		client.write(msg);
		const response = await this.waitForResponse();
		if(response[0] === 0x2f){
			const temperature = response[1];
			const warming_time = response[2];
			const formula_temperature = response[3];

			await this.setStateAsync(`${this.namespace}.kettle.preset.temperature`, {val: temperature, ack: true});
			await this.setStateAsync(`${this.namespace}.kettle.preset.warming_time`, {val: warming_time, ack: true});
			await this.setStateAsync(`${this.namespace}.kettle.preset.formula_temperature`, {val: formula_temperature, ack: true});
			await this.setStateAsync(`${this.namespace}.kettle.preset.get_preset`, {val: false, ack: true});
		}
	}

	async getDeviceInfo(){
		const msg = Buffer.from([0x64, 0x7e]);
		client.write(msg);
		const response = await this.waitForResponse();
		if(response[0] === 0x65) {
			const firmwareVersion = response[2];
			await this.extendObjectAsync(`${this.namespace}.kettle`, {
				native: {
					firmwareVersion: firmwareVersion
				}
			});
		} else {
			await this.logError(response[1], 'Get device info');
		}
	}

	async getHistory(){
		const msg = Buffer.from([0x28, 0x7e]);
		client.write(msg);
		const response = await this.waitForResponse();
		console.log(response);
		if(response[0] === 0x29){
			const counter = response[1];
			//TODO: decode history
		}
	}

	waitForResponse(){
		return new Promise( (resolve) => {
			const listener = (data) => {
				resolve(data);
				client.off('data', listener);
			};
			client.on('data', listener);
		});
	}

	async logError(code, command){
		const errorMessage = {
			0x01: 'Busy and can not execute',
			0x04: 'Command failed:'
		};

		await this.log.error(`${errorMessage[code]} ${command}`);
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Ikettle2(options);
} else {
	// otherwise start the instance directly
	new Ikettle2();
}
