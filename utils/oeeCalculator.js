const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const { oeeLogger, errorLogger } = require('../utils/logger');
const { influxdb, oeeAsPercent } = require('../config/config');
const { loadDataAndPrepareOEE } = require('../utils/downtimeManager');
const { loadProcessOrderData } = require('../src/dataLoader');

const VALID_SCORE_THRESHOLD = 1.0;
const MINIMUM_SCORE_THRESHOLD = 0.0;
const CLASSIFICATION_LEVELS = {
    WORLD_CLASS: 0.85,
    EXCELLENT: 0.7,
    GOOD: 0.6,
    AVERAGE: 0.4,
};

class OEECalculator {
    constructor() {
        this.resetOEEData();
    }

    resetOEEData() {
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

    async init() {
        try {
            const processOrderData = await loadProcessOrderData();
            oeeLogger.info(`Loaded process order data: ${JSON.stringify(processOrderData)}`);
            this.validateProcessOrderData(processOrderData);
            this.setOEEData(processOrderData[0]);
        } catch (error) {
            errorLogger.error(`Error initializing OEECalculator: ${error.message}`);
            throw error;
        }
    }

    validateProcessOrderData(data) {
        if (!data || !Array.isArray(data) || data.length === 0) {
            throw new Error('Process order data is null or undefined');
        }

        const { ProcessOrderNumber, setupTime, processingTime, teardownTime, totalPartsToBeProduced, Start, End } = data[0];
        if (!ProcessOrderNumber || setupTime == null || processingTime == null || teardownTime == null || totalPartsToBeProduced == null || Start == null || End == null) {
            throw new Error('Invalid process order data: One or more required fields are missing.');
        }
    }

    setOEEData(data) {
        const { ProcessOrderNumber, setupTime, processingTime, teardownTime, totalPartsToBeProduced, Start, End } = data;
        this.oeeData.ProcessOrderNumber = ProcessOrderNumber;
        this.oeeData.plannedProduction = setupTime + processingTime + teardownTime;
        this.oeeData.runtime = setupTime + processingTime + teardownTime;
        this.oeeData.targetPerformance = totalPartsToBeProduced;
        this.oeeData.StartTime = Start;
        this.oeeData.EndTime = End;
    }

    updateData(metric, value) {
        oeeLogger.debug(`Updating ${metric} with value: ${value}`);
        this.oeeData[metric] = value;
    }

    validateInput() {
        const { plannedProduction, runtime, actualPerformance, targetPerformance, goodProducts, totalProduction } = this.oeeData;
        oeeLogger.debug(`Validating input data: ${JSON.stringify(this.oeeData)}`);

        if (runtime <= 0) throw new Error('Invalid input data: runtime must be greater than 0');
        if (plannedProduction <= 0) throw new Error('Invalid input data: plannedProduction must be greater than 0');
        if (totalProduction < 0) throw new Error('Invalid input data: totalProduction must be non-negative');
        if (targetPerformance < 0) throw new Error('Invalid input data: targetPerformance must be non-negative');
        if (goodProducts < 0) throw new Error('Invalid input data: goodProducts must be non-negative');
        if (totalProduction > targetPerformance) throw new Error('Invalid input data: totalProduction cannot be greater than targetPerformance');
        if (goodProducts > totalProduction) throw new Error('Invalid input data: goodProducts cannot be greater than totalProduction');
    }

    async calculateMetrics() {
        this.validateInput();

        const { plannedProduction, runtime, targetPerformance, goodProducts, totalProduction, ProcessOrderNumber, StartTime, EndTime } = this.oeeData;
        oeeLogger.info(`Calculating metrics for ProcessOrderNumber: ${ProcessOrderNumber}`);

        try {
            const OEEData = loadDataAndPrepareOEE();

            const totalProductionTime = OEEData.datasets[0].data.reduce((a, b) => a + b, 0);
            const totalBreakTime = OEEData.datasets[1].data.reduce((a, b) => a + b, 0);
            const totalUnplannedDowntime = OEEData.datasets[2].data.reduce((a, b) => a + b, 0);
            const totalPlannedDowntime = OEEData.datasets[3].data.reduce((a, b) => a + b, 0);

            oeeLogger.info(`Total production time: ${totalProductionTime}`);
            oeeLogger.info(`Total break time: ${totalBreakTime}`);
            oeeLogger.info(`Total unplanned downtime: ${totalUnplannedDowntime}`);
            oeeLogger.info(`Total planned downtime: ${totalPlannedDowntime}`);

            // Log input values
            oeeLogger.info(`Input values - plannedProduction: ${plannedProduction}, runtime: ${runtime}, targetPerformance: ${targetPerformance}, goodProducts: ${goodProducts}, totalProduction: ${totalProduction}`);

            // Perform OEE calculation
            this.calculateOEE(plannedProduction, runtime, targetPerformance, goodProducts, totalProduction, totalUnplannedDowntime, totalPlannedDowntime + totalBreakTime);

            // Log calculated OEE data
            oeeLogger.info(`Calculated OEE data: ${JSON.stringify(this.oeeData)}`);
        } catch (error) {
            errorLogger.error(`Error calculating metrics: ${error.message}`);
            throw error;
        }
    }

    calculateOEE(plannedProduction, runtime, targetPerformance, goodProducts, totalProduction, actualUnplannedDowntime, actualPlannedDowntime) {
        const operatingTime = runtime - (actualUnplannedDowntime / 60) - (actualPlannedDowntime / 60);

        this.oeeData.availability = operatingTime / plannedProduction;
        this.oeeData.performance = targetPerformance > 0 ? totalProduction / targetPerformance : 0;
        this.oeeData.quality = totalProduction > 0 ? goodProducts / totalProduction : 0;
        this.oeeData.oee = this.oeeData.availability * this.oeeData.performance * this.oeeData.quality * 100;

        if (!isFinite(this.oeeData.oee)) {
            throw new Error(`Calculated OEE is not finite: ${this.oeeData.oee}`);
        }

        this.oeeData.classification = this.classifyOEE(this.oeeData.oee / 100);
    }

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

    getMetrics() {
        return this.oeeData;
    }
}

let writeApi = null;

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

async function writeOEEToInfluxDB(oee, availability, performance, quality, metadata, ProcessOrderNumber) {
    if (!writeApi) {
        errorLogger.error('InfluxDB write API is not initialized.');
        return;
    }

    try {
        const point = new Point('oee')
            .tag('plant', metadata.group_id)
            .tag('area', 'Packaging')
            .tag('line', metadata.edge_node_id)
            .tag('processOrderNumber', ProcessOrderNumber);

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