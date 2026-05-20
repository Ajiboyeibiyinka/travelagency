'use strict';

const { CraneIbeAdapter } = require('./crane-ibe-adapter');

class IbomAirAdapter extends CraneIbeAdapter {
    constructor(page) {
        super(page, 'ibom', 'https://book-ibomair.crane.aero', 'Ibom Air', 'QI');
    }
}

module.exports = { IbomAirAdapter };
