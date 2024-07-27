const { oeeLogger, errorLogger } = require('../utils/logger');
const { OEECalculator, writeOEEToInfluxDB } = require('../utils/oeeCalculator');
const { getUnplannedDowntime, getPlannedDowntime, loadDataAndPrepareChart } = require('../utils/downtimeManager');
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
        await oeeCalculator.calculateMetrics();

        const metrics = oeeCalculator.getMetrics();
        const { oee, availability, performance, quality, ProcessOrderNumber, StartTime, EndTime, plannedProduction, machine_id } = metrics;

        if (!metrics) {
            throw new Error('Metrics could not be calculated or are undefined.');
        }

        const level = oeeCalculator.classifyOEE(oee / 100);

        oeeLogger.info(`Calculated Availability: ${availability}`);
        oeeLogger.info(`Calculated Performance: ${performance}`);
        oeeLogger.info(`Calculated Quality: ${quality}`);
        oeeLogger.info(`Calculated OEE: ${oee}% (Level: ${level})`);

        // Calculate downtime
        let plannedDowntime;
        let unplannedDowntime;
        try {
            plannedDowntime = await getPlannedDowntime(ProcessOrderNumber, StartTime, EndTime);
            unplannedDowntime = await getUnplannedDowntime(ProcessOrderNumber);
        } catch (downtimeError) {
            errorLogger.error(`Error calculating downtime: ${downtimeError.message}`);
            plannedDowntime = 0;
            unplannedDowntime = 0;
        }

        // Convert StartTime and EndTime to the desired timezone
        const startTimeInTimezone = moment.tz(StartTime, "UTC").tz(TIMEZONE).format();
        const endTimeInTimezone = moment.tz(EndTime, "UTC").tz(TIMEZONE).format();

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
                plannedDowntime,
                unplannedDowntime,
                machine_id
            }
        };

        // Log summary
        oeeLogger.info(`OEE Metrics Summary: OEE=${roundedMetrics.oee}%, Availability=${roundedMetrics.availability}%, Performance=${roundedMetrics.performance}%, Quality=${roundedMetrics.quality}%, Level=${roundedMetrics.level}`);
        oeeLogger.info(`Process Data: ${JSON.stringify(roundedMetrics.processData)}`);

        // Send OEE metrics to all connected WebSocket clients
        sendWebSocketMessage('oeeData', roundedMetrics);

        if (influxdb.url && influxdb.token && influxdb.org && influxdb.bucket) {
            await writeOEEToInfluxDB(oee, availability, performance, quality, { group_id: structure.Group_id, edge_node_id: structure.edge_node_id });
            oeeLogger.info('Metrics written to InfluxDB.');
        }

        // Load chart data and send it via WebSocket
        let chartData;
        try {
            chartData = loadDataAndPrepareChart();
        } catch (chartError) {
            errorLogger.error(`Error loading or preparing chart data: ${chartError.message}`);
            return;
        }

        sendWebSocketMessage('chartData', chartData);

        // Log chart data
        oeeLogger.info(`Chart Data: ${JSON.stringify(chartData)}`);

    } catch (error) {
        errorLogger.error(`Error calculating metrics: ${error.message}`);
    }
}

module.exports = { updateMetric, processMetrics, setWebSocketServer };