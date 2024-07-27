const { oeeLogger, errorLogger } = require('../utils/logger');
const { OEECalculator, writeOEEToInfluxDB } = require('../utils/oeeCalculator');
const { loadDataAndPrepareOEE } = require('../utils/downtimeManager');
const { influxdb, structure } = require('../config/config');
const { setWebSocketServer, sendWebSocketMessage } = require('./webSocketUtils');
const moment = require('moment-timezone');

const TIMEZONE = process.env.TIMEZONE || 'Europe/Berlin'; // Set timezone from .env or default to 'Europe/Berlin'

const oeeCalculator = new OEECalculator();
let receivedMetrics = {};

/**
 * Update a metric with a new value.
 * @param {string} name - The metric name.
 * @param {number} value - The metric value.
 */
function updateMetric(name, value) {
    receivedMetrics[name] = value;
    oeeCalculator.updateData(name, value);
    oeeLogger.debug(`Metric updated: ${name} = ${value}`);
}

/**
 * Process metrics, calculate OEE, and send data via WebSocket.
 */
async function processMetrics() {
    try {
        oeeLogger.info('Starting metrics processing.');
        await oeeCalculator.init();

        // Load chart data and prepare OEE data
        let OEEData;
        try {
            OEEData = loadDataAndPrepareOEE();
        } catch (chartError) {
            errorLogger.error(`Error loading or preparing chart data: ${chartError.message}`);
            return;
        }

        // Calculate the total times from the chart data
        const totalProductionTime = OEEData.datasets[0].data.reduce((a, b) => a + b, 0);
        const totalBreakTime = OEEData.datasets[1].data.reduce((a, b) => a + b, 0);
        const totalUnplannedDowntime = OEEData.datasets[2].data.reduce((a, b) => a + b, 0);
        const totalPlannedDowntime = OEEData.datasets[3].data.reduce((a, b) => a + b, 0);

        oeeLogger.info(`Total production time: ${totalProductionTime}`);
        oeeLogger.info(`Total break time: ${totalBreakTime}`);
        oeeLogger.info(`Total unplanned downtime: ${totalUnplannedDowntime}`);
        oeeLogger.info(`Total planned downtime: ${totalPlannedDowntime}`);

        // Calculate metrics using the new total times
        await oeeCalculator.calculateMetrics(totalUnplannedDowntime, totalPlannedDowntime + totalBreakTime);

        const metrics = oeeCalculator.getMetrics();
        const { oee, availability, performance, quality, ProcessOrderNumber, StartTime, EndTime, plannedProduction, machine_id, MaterialNumber, MaterialDescription } = metrics;

        if (!metrics) {
            throw new Error('Metrics could not be calculated or are undefined.');
        }

        const level = oeeCalculator.classifyOEE(oee / 100);

        oeeLogger.info(`Calculated Availability: ${availability}`);
        oeeLogger.info(`Calculated Performance: ${performance}`);
        oeeLogger.info(`Calculated Quality: ${quality}`);
        oeeLogger.info(`Calculated OEE: ${oee}% (Level: ${level})`);

        // Convert StartTime and EndTime to the desired timezone
        const startTimeInTimezone = moment.tz(StartTime, "UTC").tz(TIMEZONE).format();
        const endTimeInTimezone = moment.tz(EndTime, "UTC").tz(TIMEZONE).format();

        // Prepare payload
        // Prepare payload
        const roundedMetrics = {
            oee: Math.round(oee * 100) / 100,
            availability: Math.round(availability * 10000) / 100,
            performance: Math.round(performance * 10000) / 100,
            quality: Math.round(quality * 10000) / 100,
            level: level,
            processData: {
                ProcessOrderNumber,
                StartTime: startTimeInTimezone,
                EndTime: endTimeInTimezone,
                plannedProduction,
                plannedDowntime: totalPlannedDowntime, // Use the new total planned downtime
                unplannedDowntime: totalUnplannedDowntime, // Use the new total unplanned downtime
                MaterialNumber: MaterialNumber, // Add MaterialNumber
                MaterialDescription: MaterialDescription, // Add MaterialDescription
                machine_id
            }
        };

        // Log summary
        oeeLogger.info(`OEE Metrics Summary: OEE=${roundedMetrics.oee}%, Availability=${roundedMetrics.availability}%, Performance=${roundedMetrics.performance}%, Quality=${roundedMetrics.quality}%, Level=${roundedMetrics.level}`);
        oeeLogger.info(`Process Data: ${JSON.stringify(roundedMetrics.processData)}`);

        // Send OEE metrics to all connected WebSocket clients
        sendWebSocketMessage('oeeData', roundedMetrics);

        if (influxdb.url && influxdb.token && influxdb.org && influxdb.bucket) {
            await writeOEEToInfluxDB(roundedMetrics); // Pass the entire metrics object
            oeeLogger.info('Metrics written to InfluxDB.');
        }

        // Send chart data via WebSocket
        sendWebSocketMessage('OEEData', OEEData);

        // Log chart data
        oeeLogger.info(`Chart Data: ${JSON.stringify(OEEData)}`);

    } catch (error) {
        errorLogger.error(`Error calculating metrics: ${error.message}`);
    }
}

module.exports = { updateMetric, processMetrics, setWebSocketServer };