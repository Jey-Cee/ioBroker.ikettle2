'use strict';

const { expect } = require('chai');
const { FrameParser, parseStatus, litersFromRaw, calibrationPoints, median } = require('./lib/protocol');

describe('FrameParser', () => {
	it('returns one message per terminator', () => {
		const parser = new FrameParser();
		const frames = parser.push(Buffer.from('14001f08b1007e', 'hex'));
		expect(frames).to.have.length(1);
		expect(frames[0].toString('hex')).to.equal('14001f08b1007e');
	});

	it('splits merged messages', () => {
		const parser = new FrameParser();
		const frames = parser.push(Buffer.from('0300' + '7e' + '14011f08b1007e', 'hex'));
		expect(frames.map(f => f.toString('hex'))).to.deep.equal(['03007e', '14011f08b1007e']);
	});

	it('joins a message split over two chunks', () => {
		const parser = new FrameParser();
		expect(parser.push(Buffer.from('14001f', 'hex'))).to.have.length(0);
		const frames = parser.push(Buffer.from('08b1007e', 'hex'));
		expect(frames.map(f => f.toString('hex'))).to.deep.equal(['14001f08b1007e']);
	});

	it('drops a buffer that never gets a terminator', () => {
		const parser = new FrameParser();
		parser.push(Buffer.alloc(300, 1));
		expect(parser.buffer.length).to.equal(0);
	});
});

describe('parseStatus', () => {
	it('decodes a status message', () => {
		expect(parseStatus(Buffer.from('14011f08b1007e', 'hex'))).to.deep.equal({
			status: 1,
			temperature: 31,
			raw: 2225,
			onBase: true,
		});
	});

	it('detects the kettle off the base', () => {
		const status = parseStatus(Buffer.from('1400140712007e', 'hex'));
		expect(status && status.onBase).to.equal(false);
	});

	it('treats 127 °C as off the base even with an on-base sensor value', () => {
		// recorded while the kettle was put back: temp 127, raw 2154 (0x086a)
		const status = parseStatus(Buffer.from('14007f086a007e', 'hex'));
		expect(status && status.onBase).to.equal(false);
	});

	it('ignores other messages', () => {
		expect(parseStatus(Buffer.from('03007e', 'hex'))).to.equal(null);
	});
});

describe('litersFromRaw', () => {
	// measured with a real iKettle 2.0 (one-minute averages): empty 2067, 1 l 2131, 1.8 l 2162
	const three = calibrationPoints({
		levelEmptyRaw: 2067,
		levelLowRaw: 2131,
		levelLowLiters: 1,
		levelHighRaw: 2162,
		levelHighLiters: 1.8,
	});

	it('matches the calibration points', () => {
		expect(litersFromRaw(2067, three)).to.equal(0);
		expect(litersFromRaw(2131, three)).to.equal(1);
		expect(litersFromRaw(2162, three)).to.equal(1.8);
	});

	it('uses the line of the right segment', () => {
		expect(litersFromRaw(2099, three)).to.equal(0.5);
		expect(litersFromRaw(2146.5, three)).to.equal(1.4);
	});

	it('extends the outer lines', () => {
		expect(litersFromRaw(2170, three)).to.equal(2);
		expect(litersFromRaw(1500, three)).to.equal(0);
	});

	it('works with two points when the empty point is not set', () => {
		const defaults = calibrationPoints({
			levelEmptyRaw: 0,
			levelLowRaw: 2090,
			levelLowLiters: 0,
			levelHighRaw: 2185,
			levelHighLiters: 1.8,
		});
		expect(defaults).to.have.length(2);
		expect(litersFromRaw(2185, defaults)).to.equal(1.8);
	});

	it('returns null for an unusable calibration', () => {
		expect(
			litersFromRaw(2200, [
				{ raw: 2200, liters: 1 },
				{ raw: 2200, liters: 1.8 },
			]),
		).to.equal(null);
		// more water with a lower raw value
		expect(
			litersFromRaw(2200, [
				{ raw: 2100, liters: 1.8 },
				{ raw: 2150, liters: 1 },
			]),
		).to.equal(null);
	});
});

describe('median', () => {
	it('returns the middle value', () => {
		expect(median([2221, 2196, 2224, 2222, 2300])).to.equal(2222);
	});

	it('returns null for no values', () => {
		expect(median([])).to.equal(null);
	});
});
