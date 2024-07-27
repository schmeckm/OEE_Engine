const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const { oeeLogger, errorLogger } = require('../utils/logger');
const { influxdb, oeeAsPercent } = require('../config/config');
const { getPlannedDowntime, getunplannedDowntime, } = require('../utils/downtimeManager');
const { loadProcessOrderData } = require('../src/dataLoader');
const path = require('path');

const VALID_SCORE_THRESHOLD = 1.0;
const MINIMUM_SCORE_THRESHOLD = 0.0;
const CLASSIFICATION_LEVELS = {
    WORLD_CLASS: 0.85,
    EXCELLENT: 0.7,
    GOOD: 0.6,
    AVERAGE: 0.4,
};

// OEECalculator class for calculating Overall Equipment Effectiveness
class OEECalculator {
    constructor() {
        this.oeeData = {
            ProcessOrderNumber: null,
            plannedProduction: 0,
            runtime: 0,
            actualPerformance: 0,
            targetPerformance: 0,
            goodProducts: 0,
            totalProduction: 0,
            unplannedDowntime: 600,
            availability: 0,
            performance: 0,
            quality: 0,
            oee: 0,
        };
    }

    // Initialize the OEECalculator with process order data
    async init() {
        try {
            const processOrderData = await loadProcessOrderData();
            oeeLogger.info(`Loaded process order data: ${JSON.stringify(processOrderData)}`);

            if (!processOrderData || !Array.isArray(processOrderData) || processOrderData.length === 0) {
                throw new Error('Process order data is null or undefined');
            }

            const data = processOrderData[0]; // Assuming single process order data for now
            const { ProcessOrderNumber, setupTime, processingTime, teardownTime, totalPartsToBeProduced, Start, End } = data;

            if (!ProcessOrderNumber) {
                throw new Error('Invalid process order data: ProcessOrderNumber is missing.');
            }
            if (setupTime == null || processingTime == null || teardownTime == null || totalPartsToBeProduced == null || Start == null || End == null) {
                throw new Error('Invalid process order data: One or more required fields are missing.');
            }

            this.oeeData.ProcessOrderNumber = ProcessOrderNumber;
            this.oeeData.plannedProduction = setupTime + processingTime + teardownTime;
            this.oeeData.runtime = setupTime + processingTime + teardownTime;
            this.oeeData.targetPerformance = totalPartsToBeProduced;
            this.oeeData.StartTime = Start;
            this.oeeData.EndTime = End;
        } catch (error) {
            errorLogger.error(`Error initializing OEECalculator: ${error.message}`);
            throw error;
        }
    }

    // Update a specific metric in the OEECalculator
    updateData(metric, value) {
        oeeLogger.debug(`Updating ${metric} with value: ${value}`);
        this.oeeData[metric] = value;
    }

    // Validate the input data for OEE calculation
    validateInput() {
        const { plannedProduction, runtime, actualPerformance, targetPerformance, goodProducts, totalProduction } = this.oeeData;

        oeeLogger.debug(`Validating input data: ${JSON.stringify(this.oeeData)}`);

        if (runtime <= 0) {
            oeeLogger.error('Invalid input data: runtime must be greater than 0');
            throw new Error('Invalid input data');
        }
        if (plannedProduction <= 0) {
            oeeLogger.error('Invalid input data: plannedProduction must be greater than 0');
            throw new Error('Invalid input data');
        }
        if (totalProduction < 0) {
            oeeLogger.error('Invalid input data: totalProduction must be non-negative');
            throw new Error('Invalid input data');
        }
        if (targetPerformance < 0) {
            oeeLogger.error('Invalid input data: targetPerformance must be non-negative');
            throw new Error('Invalid input data');
        }
        if (goodProducts < 0) {
            oeeLogger.error('Invalid input data: goodProducts must be non-negative');
            throw new Error('Invalid input data');
        }
        if (totalProduction > targetPerformance) {
            oeeLogger.error('Invalid input data: totalProduction cannot be greater than targetPerformance');
            throw new Error('Invalid input data');
        }
        if (goodProducts > totalProduction) {
            oeeLogger.error('Invalid input data: goodProducts cannot be greater than totalProduction');
            throw new Error('Invalid input data');
        }
    }

    // Calculate the OEE metrics
    async calculateMetrics() {
        this.validateInput();

        const { plannedProduction, runtime, targetPerformance, goodProducts, totalProduction, ProcessOrderNumber, StartTime, EndTime } = this.oeeData;
        oeeLogger.info(`Calculating metrics for ProcessOrderNumber: ${ProcessOrderNumber}`);

        // Calculate unplanned downtime
        const unplannedDowntimeMinutes = await getunplannedDowntime(ProcessOrderNumber);
        oeeLogger.debug(`Unplanned downtime minutes: ${unplannedDowntimeMinutes}`);
        const actualUnplannedDowntime = unplannedDowntimeMinutes !== undefined ? unplannedDowntimeMinutes : 10;

        // Calculate planned downtime
        const plannedDowntimeMinutes = await getPlannedDowntime(ProcessOrderNumber, StartTime, EndTime);
        oeeLogger.debug(`Planned downtime minutes: ${plannedDowntimeMinutes}`);
        const actualPlannedDowntime = plannedDowntimeMinutes !== undefined ? plannedDowntimeMinutes : 10;

        const operatingTime = runtime - (actualUnplannedDowntime / 60) - (actualPlannedDowntime / 60);

        this.oeeData.availability = operatingTime / plannedProduction;
        this.oeeData.performance = (targetPerformance > 0 ? (totalProduction / targetPerformance) : 0);
        this.oeeData.quality = (totalProduction > 0 ? (goodProducts / totalProduction) : 0);
        this.oeeData.oee = this.oeeData.availability * this.oeeData.performance * this.oeeData.quality * 100;

        if (!isFinite(this.oeeData.oee)) {
            throw new Error(`Calculated OEE is not finite: ${this.oeeData.oee}`);
        }

        this.oeeData.classification = this.classifyOEE(this.oeeData.oee / 100);
    }

    // Classify the OEE score
    classifyOEE(score) {
        if (score > VALID_SCORE_THRESHOLD || score < MINIMUM_SCORE_THRESHOLD) {
            throw new Error(`Invalid input: score must be between ${MINIMUM_SCORE_THRESHOLD} and ${VALID_SCORE_THRESHOLD}`);
        }
        if (score >= CLASSIFICATION_LEVELS.WORLD_CLASS) return "World Class";
        if (score >= CLASSIFICATION_LEVELS.EXCELLENT) return "Excellent";
        if (score >= CLASSIFICATION_LEVELS.GOOD) return "Good";
        if (score >= CLASSIFICATION_LEVELS.AVERAGE) return "Average";
        return "Poor";
    }

    // Get the calculated OEE metrics
    getMetrics() {
        return this.oeeData;
    }
}

let writeApi = null;

// Initialize InfluxDB write API if the configuration is complete
try {
    if (influxdb.url && influxdb.token && influxdb.org && influxdb.bucket) {
        const influxDB = new InfluxDB({ url: influxdb.url, token: influxdb.token });
        writeApi = influxDB.getWriteApi(influxdb.org, influxdb.bucket);
    } else {
        throw new Error('InfluxDB configuration is incomplete.');
    }
} catch (error) {
    errorLogger.error(`InfluxDB initialization error: ${error.message}`);
}

// Function to write OEE metrics to InfluxDB
async function writeOEEToInfluxDB(oee, availability, performance, quality, metadata) {
    if (!writeApi) {
        errorLogger.error('InfluxDB write API is not initialized.');
        return;
    }

    try {
        const point = new Point('oee')
            .tag('plant', metadata.group_id)
            .tag('area', 'Packaging')
            .tag('line', metadata.edge_node_id);

        Object.keys(metadata).forEach(key => {
            if (typeof metadata[key] !== 'object') {
                point.tag(key, metadata[key]);
            }
        });

        point
            .floatField('oee', oeeAsPercent ? oee : oee / 100)
            .floatField('availability', oeeAsPercent ? availability * 100 : availability)
            .floatField('performance', oeeAsPercent ? performance * 100 : performance)
            .floatField('quality', oeeAsPercent ? quality * 100 : quality);

        writeApi.writePoint(point);
        await writeApi.flush();
    } catch (error) {
        errorLogger.error(`Error writing to InfluxDB: ${error.message}`);
    }
}

module.exports = { OEECalculator, writeOEEToInfluxDB };