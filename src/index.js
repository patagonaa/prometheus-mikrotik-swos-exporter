const urllib = require('urllib');
var express = require('express')
var app = express();

function fixBrokenJson(brokenJson) {
    return brokenJson
        .replace(/([{,])([a-zA-Z][a-zA-Z0-9]+)/g, '$1"$2"') // {abc: 123} -> {"abc": 123}
        .replace(/'/g, '"') // ' -> "
        .replace(/(0x[0-9a-zA-Z]+)/g, '"$1"'); // 0x1234 -> "0x1234"
}

function parseBrokenJson(brokenJson) {
    return JSON.parse(fixBrokenJson(brokenJson));
}

function parseHexInt16(hex) {
    let result = parseInt(hex, 16);
    if ((result & 0x8000) !== 0) {
        result -= 0x10000;
    }
    return result;
}

function parseHexInt32(hex) {
    let result = parseInt(hex, 16);
    if ((result & 0x80000000) !== 0) {
        result -= 0x100000000;
    }
    return result;
}

async function doRequest(target, endPoint, user, password) {
    let requestOptions = {
        digestAuth: `${user}:${password}`,
        dataType: 'text'
    };

    let url = `http://${target}/${endPoint}`;

    return await new Promise((resolve, reject) => {
        urllib.request(url, requestOptions, (err, data, res) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(data);
        });
    });
}

async function getLink(target, user, password) {
    let link = await doRequest(target, 'link.b', user, password);
    return parseBrokenJson(link.toString());
}

async function getSfp(target, user, password) {
    let sfp = await doRequest(target, 'sfp.b', user, password);
    return parseBrokenJson(sfp.toString());
}

async function getSystem(target, user, password) {
    let sys = await doRequest(target, 'sys.b', user, password);
    return parseBrokenJson(sys.toString());
}

const client = require('prom-client');

const sfpUpGauge = new client.Gauge({
    name: 'swos_sfp_up',
    help: 'Is a SFP Module inserted',
    labelNames: ['sfp_name']
});
const sfpTempGauge = new client.Gauge({
    name: 'swos_sfp_temperature_celsius',
    help: 'Temperature of SFP Module',
    labelNames: ['sfp_name']
});
const sfpVccGauge = new client.Gauge({
    name: 'swos_sfp_vcc_volts',
    help: 'VCC voltage of SFP Module',
    labelNames: ['sfp_name']
});
const sfpTxBiasGauge = new client.Gauge({
    name: 'swos_sfp_tx_bias_milliamps',
    help: 'TX Bias (mA) of SFP Module',
    labelNames: ['sfp_name']
});
const sfpTxPowerGauge = new client.Gauge({
    name: 'swos_sfp_tx_power_milliwatts',
    help: 'TX Power (mW) of SFP Module',
    labelNames: ['sfp_name']
});
const sfpRxPowerGauge = new client.Gauge({
    name: 'swos_sfp_rx_power_milliwatts',
    help: 'RX Power (mW) of SFP Module',
    labelNames: ['sfp_name']
});
const deviceTemperatureGauge = new client.Gauge({
    name: 'swos_device_temperature',
    help: 'Temperature of SwOS Device'
});
const deviceUptimeGauge = new client.Gauge({
    name: 'swos_device_uptime_seconds',
    help: 'Uptime of SwOS Device'
});
const deviceVoltageGauge = new client.Gauge({
    name: 'swos_device_voltage_volts',
    help: 'Input voltage of SwOS Device'
});
const poeCurrentGauge = new client.Gauge({
    name: 'swos_port_poe_current_milliamps',
    help: 'PoE Current on a port',
    labelNames: ['port_name']
});
const poePowerGauge = new client.Gauge({
    name: 'swos_port_poe_power_watts',
    help: 'PoE Power on a port',
    labelNames: ['port_name']
});

// turn
// {a: [0, 1], b: [2, 3]}
// into
// [{a: 0, b: 2}, {a: 1, b: 3}]
function pivotObject(data, keys) {
    let toReturn = [];
    let count = (data[keys[0]] || {}).length || 0;

    for (let i = 0; i < count; i++) {
        let entry = { index: i };
        for (let key of keys) {
            entry[key] = data[key][i];
        }
        toReturn.push(entry);
    }
    return toReturn;
}

async function getMetrics(target, user, password) {
    client.register.resetMetrics();

    let linkData = await getLink(target, user, password);

    let ports = pivotObject(linkData, ['poes', 'curr', 'pwr']);

    for (let port of ports) {
        let labels = { port_name: `Port${port.index + 1}` };
        if (parseInt(port.poes, 16) === 0)
            continue; // Port has no PoE

        poeCurrentGauge.set(labels, parseHexInt16(port.curr));
        poePowerGauge.set(labels, parseHexInt16(port.pwr) / 10);
    }

    let sfpData = await getSfp(target, user, password);
    let sfps = Array.isArray(sfpData.vnd) ? pivotObject(sfpData, ['vnd', 'tmp', 'vcc', 'tbs', 'tpw', 'rpw']) : [sfpData];

    for (let sfp of sfps) {

        let labels = { sfp_name: `SFP${(sfp.index + 1) || ''}` };

        if (sfp.vnd == '') {
            sfpUpGauge.set(labels, 0);
            continue;
        }

        sfpUpGauge.set(labels, 1);

        let temperature = parseHexInt32(sfp.tmp);
        if (temperature != -128)
            sfpTempGauge.set(labels, temperature);

        let voltage = parseHexInt16(sfp.vcc);
        if (voltage != 0)
            sfpVccGauge.set(labels, voltage / 1000);

        let txBias = parseHexInt16(sfp.tbs);
        if (txBias != 0)
            sfpTxBiasGauge.set(labels, txBias);

        let txPowerMilliwatts = parseHexInt16(sfp.tpw);
        if (txPowerMilliwatts != 0)
            sfpTxPowerGauge.set(labels, txPowerMilliwatts / 10000);

        let rxPowerMilliwatts = parseHexInt16(sfp.rpw);
        if (rxPowerMilliwatts != 0)
            sfpRxPowerGauge.set(labels, rxPowerMilliwatts / 10000);
    }

    let sysData = await getSystem(target, user, password);
    if (sysData.temp)
        deviceTemperatureGauge.set({}, parseHexInt32(sysData.temp));
    if (sysData.upt)
        deviceUptimeGauge.set({}, parseHexInt32(sysData.upt) / 100);
    if (sysData.volt)
        deviceVoltageGauge.set({}, parseHexInt16(sysData.volt) / 10);
}

app.get('/metrics', async function (req, res, next) {
    try {
        console.info('scraping', req.query.target);
        await getMetrics(req.query.target, req.query.user || 'admin', req.query.password || '');
        res.end(client.register.metrics());
    } catch (e) {
        console.error(e);
        next(e);
    }
});

app.listen(3000, function () {
    console.log('Exporter listening on port 3000!')
});