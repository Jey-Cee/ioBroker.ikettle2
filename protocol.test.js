'use strict';

const { expect } = require('chai');
const { FrameParser, parseStatus, litersFromRaw, median } = require('./lib/protocol');

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

	it('ignores other messages', () => {
		expect(parseStatus(Buffer.from('03007e', 'hex'))).to.equal(null);
	});
});

describe('litersFromRaw', () => {
	const cal = { lowRaw: 2169, lowLiters: 1, highRaw: 2221, highLiters: 1.8 };

	it('matches the calibration points', () => {
		expect(litersFromRaw(2169, cal)).to.equal(1);
		expect(litersFromRaw(2221, cal)).to.equal(1.8);
	});

	it('interpolates between the points', () => {
		expect(litersFromRaw(2195, cal)).to.equal(1.4);
	});

	it('never returns less than 0', () => {
		expect(litersFromRaw(1500, cal)).to.equal(0);
	});

	it('keeps the old fixed scale with the default settings', () => {
		const defaults = { lowRaw: 2090, lowLiters: 0, highRaw: 2185, highLiters: 1.8 };
		expect(litersFromRaw(2185, defaults)).to.equal(1.8);
	});

	it('returns null for an unusable calibration', () => {
		expect(litersFromRaw(2200, { lowRaw: 2200, lowLiters: 1, highRaw: 2200, highLiters: 1.8 })).to.equal(null);
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
