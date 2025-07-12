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

function parseHexString(hex) {
    return Buffer.from(hex, 'hex').toString();
}

async function doRequest(target, endPoint, user, password) {
    let error;
    for (let i = 0; i < 3; i++) {
        try {
            let requestOptions = {
                digestAuth: `${user}:${password}`,
                dataType: 'text',
                timeout: [1000, 2000]
            };

            let url = `http://${target}/${endPoint}`;

            let response = await urllib.request(url, requestOptions);

            if (response.status != 200)
                throw response;

            return response.data;
        } catch (err) {
            error = err;
        }
    }
    console.error(error);
    return null;
}

async function getLink(target, user, password) {
    let link = await doRequest(target, 'link.b', user, password);
    return parseBrokenJson(link.toString());
}

async function getSfp(target, user, password) {
    let sfp = await doRequest(target, 'sfp.b', user, password);
    return parseBrokenJson(sfp.toString());
}

async function getDhost(target, user, password) {
    let dhost = await doRequest(target, '!dhost.b', user, password);
    if (dhost == null)
        return null;
    return parseBrokenJson(dhost.toString());
}

const client = require('prom-client');
const sfpTxPowerGauge = new client.Gauge({
    name: 'swos_sfp_tx_power_milliwatts',
    help: 'TX Power (mW) of SFP module',
    labelNames: ['target', 'sfp_name', 'sfp_desc']
});
const sfpRxPowerGauge = new client.Gauge({
    name: 'swos_sfp_rx_power_milliwatts',
    help: 'RX Power (mW) of SFP module',
    labelNames: ['target', 'sfp_name', 'sfp_desc']
});


const macAddressTableGauge = new client.Gauge({
    name: 'swos_mac_addr_table_count',
    help: 'Count of entries in mac address table',
    labelNames: ['target', 'vlan', 'port_name', 'port_desc']
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
            if (data[key] == null)
                continue;
            entry[key] = data[key][i];
        }
        toReturn.push(entry);
    }
    return toReturn;
}

async function getMetrics(target, user, password) {
    client.register.resetMetrics();

    let linkData = await getLink(target, user, password);
    let ports = pivotObject(linkData, ['nm']);

    try {
        let macTableData = await getDhost(target, user, password);

        if (macTableData != null) {
            let macTableGrouped = {};
            for (const entry of macTableData) {
                var key = `${parseHexInt16(entry.vid)}|${parseHexInt16(entry.prt)}`;
                if (macTableGrouped[key] == null) {
                    macTableGrouped[key] = new Set();
                }
                macTableGrouped[key].add(entry.adr);
            }

            for (const key of Object.keys(macTableGrouped)) {
                let split = key.split('|');
                let vlan = split[0];
                let port = split[1];
                macAddressTableGauge.set({ target: target, vlan: vlan, port_name: 'Port' + ((+port) + 1), port_desc: parseHexString(ports[port].nm) }, macTableGrouped[key].size);
            }
        }
    } catch (e) {
        console.error(e);
    }

    let sfpData = await getSfp(target, user, password);
    let sfps = Array.isArray(sfpData.vnd) ? pivotObject(sfpData, ['vnd', 'tpw', 'rpw']) : [{ index: 0, ...sfpData }];

    for (let sfp of sfps) {
        let portIndex = ports.length - sfps.length + sfp.index; // assume sfps are always at the end of the port list

        let labels = { target: target, sfp_name: `SFP${(sfp.index + 1) || ''}`, sfp_desc: parseHexString(ports[portIndex].nm) };

        if (sfp.vnd == '') {
            continue;
        }

        let txPowerMilliwatts = parseHexInt16(sfp.tpw);
        if (txPowerMilliwatts != 0)
            sfpTxPowerGauge.set(labels, txPowerMilliwatts / 10000);

        let rxPowerMilliwatts = parseHexInt16(sfp.rpw);
        if (rxPowerMilliwatts != 0)
            sfpRxPowerGauge.set(labels, rxPowerMilliwatts / 10000);
    }
}

app.get('/metrics', async function (req, res, next) {
    try {
        console.info('scraping', req.query.target);
        await getMetrics(req.query.target, req.query.user || 'admin', req.query.password || '');
        res.set('Content-Type', client.register.contentType);
        res.end(await client.register.metrics());
    } catch (e) {
        console.error(e);
        next(e);
    }
});

app.listen(3000, function () {
    console.log('Exporter listening on port 3000!')
});
