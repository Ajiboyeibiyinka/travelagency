'use strict';

const { CraneIbeAdapter } = require('./crane-ibe-adapter');

class ArikAirAdapter extends CraneIbeAdapter {
    constructor(page) {
        super(page, 'arik', 'https://arikair.crane.aero', 'Arik Air', 'W3');
    }
}

module.exports = { ArikAirAdapter };
