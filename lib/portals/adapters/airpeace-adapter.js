'use strict';

const { CraneIbeAdapter } = require('./crane-ibe-adapter');

class AirPeaceAdapter extends CraneIbeAdapter {
    constructor(page) {
        super(page, 'airpeace', 'https://book-airpeace.crane.aero', 'Air Peace', 'P4');
    }
}

module.exports = { AirPeaceAdapter };
