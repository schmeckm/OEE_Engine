const fs = require('fs');
const path = require('path');
const moment = require('moment');
const { oeeLogger, errorLogger } = require('../utils/logger');

const unplannedDowntimeFilePath = path.resolve(__dirname, '../data/unplannedDowntime.json');
const plannedDowntimeFilePath = path.resolve(__dirname, '../data/plannedDowntime.json');
const processOrderFilePath = path.resolve(__dirname, '../data/processOrder.json');
const shiftModelFilePath = path.resolve(__dirname, '../data/shiftModel.json');

let unplannedDowntimeCache = null;
let plannedDowntimeCache = null;
let processOrderDataCache = null;
let shiftModelDataCache = null;

function loadJsonData(filePath) {
    try {
        oeeLogger.debug(`Loading JSON data from ${filePath}`);
        const data = fs.readFileSync(filePath, 'utf8');
        const jsonData = JSON.parse(data);
        oeeLogger.info(`Content of ${filePath} loaded successfully`);
        return jsonData;
    } catch (error) {
        errorLogger.error(`Error loading JSON data from ${filePath}: ${error.message}`);
        throw error;
    }
}

function loadUnplannedDowntimeData() {
    if (!unplannedDowntimeCache) {
        unplannedDowntimeCache = loadJsonData(unplannedDowntimeFilePath);
        oeeLogger.info(`Unplanned downtime data loaded from ${unplannedDowntimeFilePath}`);
    }
    return unplannedDowntimeCache;
}

function loadPlannedDowntimeData() {
    if (!plannedDowntimeCache) {
        plannedDowntimeCache = loadJsonData(plannedDowntimeFilePath);
        oeeLogger.info(`Planned downtime data loaded from ${plannedDowntimeFilePath}`);
    }
    return plannedDowntimeCache;
}

function loadProcessOrderData() {
    if (!processOrderDataCache) {
        processOrderDataCache = loadJsonData(processOrderFilePath);
        oeeLogger.info(`Process order data loaded from ${processOrderFilePath}`);
    }
    return processOrderDataCache;
}

function loadShiftModelData() {
    if (!shiftModelDataCache) {
        shiftModelDataCache = loadJsonData(shiftModelFilePath);
        oeeLogger.info(`Shift model data loaded from ${shiftModelFilePath}`);
    }
    return shiftModelDataCache;
}

function parseDate(dateStr) {
    return moment.utc(dateStr);
}

function filterDowntime(downtimes, startTime, endTime) {
    return downtimes.filter(downtime => {
        const start = parseDate(downtime.Start);
        const end = parseDate(downtime.End);
        return start.isBetween(startTime, endTime, null, '[]') || end.isBetween(startTime, endTime, null, '[]');
    });
}

function getUnplannedDowntime(processOrderNumber) {
    try {
        const unplannedDowntimeEntries = loadUnplannedDowntimeData();
        const totalDowntimeMinutes = unplannedDowntimeEntries.reduce((total, entry) => {
            if (entry.ProcessOrderNumber === processOrderNumber) {
                total += entry.Differenz;
            }
            return total;
        }, 0);

        oeeLogger.info(`Total accumulated unplanned downtime for ProcessOrderNumber ${processOrderNumber}: ${totalDowntimeMinutes} minutes`);
        return totalDowntimeMinutes;
    } catch (error) {
        errorLogger.error(`Error reading or processing unplannedDowntime.json: ${error.message}`);
        throw error;
    }
}

function getPlannedDowntime(processOrderNumber, startTime, endTime) {
    try {
        const plannedDowntimeEntries = loadPlannedDowntimeData();
        const start = parseDate(startTime).valueOf();
        const end = parseDate(endTime).valueOf();

        const totalDowntimeMinutes = plannedDowntimeEntries.reduce((total, entry) => {
            if (!entry.Start || !entry.End) {
                oeeLogger.warn(`Undefined Start or End in entry: ${JSON.stringify(entry)}`);
                return total;
            }

            const entryStart = parseDate(entry.Start).valueOf();
            const entryEnd = parseDate(entry.End).valueOf();
            oeeLogger.debug(`Processing entry for ProcessOrderNumber ${entry.ProcessOrderNumber}: Start ${entry.Start}, End ${entry.End}`);

            if (entry.ProcessOrderNumber === processOrderNumber && entryStart < end && entryEnd > start) {
                const overlapStart = Math.max(start, entryStart);
                const overlapEnd = Math.min(end, entryEnd);
                const duration = (overlapEnd - overlapStart) / (1000 * 60);
                oeeLogger.debug(`Overlap found: starts at ${new Date(overlapStart)}, ends at ${new Date(overlapEnd)}, duration ${duration} minutes`);
                total += duration;
            }
            return total;
        }, 0);

        oeeLogger.info(`Total accumulated planned downtime for ProcessOrderNumber ${processOrderNumber}: ${totalDowntimeMinutes} minutes`);
        return totalDowntimeMinutes;
    } catch (error) {
        errorLogger.error(`Error reading or processing plannedDowntime.json: ${error.message}`);
        throw error;
    }
}

function calculateBreakDuration(breakStart, breakEnd) {
    const breakStartTime = moment(breakStart, "HH:mm");
    const breakEndTime = moment(breakEnd, "HH:mm");
    return breakEndTime.diff(breakStartTime, 'minutes');
}

function filterAndCalculateDurations(processOrder, plannedDowntime, unplannedDowntime, shifts) {
    const orderStart = parseDate(processOrder.Start).startOf('hour');
    const orderEnd = parseDate(processOrder.End).endOf('hour');

    const filteredPlannedDowntime = plannedDowntime.filter(downtime => {
        const start = parseDate(downtime.Start);
        const end = parseDate(downtime.End);
        return (start.isBetween(orderStart, orderEnd, null, '[)') || end.isBetween(orderStart, orderEnd, null, '(]'));
    });

    const filteredUnplannedDowntime = unplannedDowntime.filter(downtime => {
        const start = parseDate(downtime.Start);
        const end = parseDate(downtime.End);
        return (start.isBetween(orderStart, orderEnd, null, '[)') || end.isBetween(orderStart, orderEnd, null, '(]'));
    });

    const filteredBreaks = shifts.flatMap(shift => {
        const shiftStart = moment.utc(`${moment(orderStart).format('YYYY-MM-DD')} ${shift.shift_start_time}`, "YYYY-MM-DD HH:mm");
        const shiftEnd = moment.utc(`${moment(orderStart).format('YYYY-MM-DD')} ${shift.shift_end_time}`, "YYYY-MM-DD HH:mm");
        const breakStart = moment.utc(`${moment(orderStart).format('YYYY-MM-DD')} ${shift.break_start}`, "YYYY-MM-DD HH:mm");
        const breakEnd = moment.utc(`${moment(orderStart).format('YYYY-MM-DD')} ${shift.break_end}`, "YYYY-MM-DD HH:mm");

        if (breakEnd.isBefore(breakStart)) {
            breakEnd.add(1, 'day');
        }
        if (shiftEnd.isBefore(shiftStart)) {
            shiftEnd.add(1, 'day');
        }

        if (shift.machine_id === processOrder.machine_id) {
            return [{
                breakDuration: calculateBreakDuration(shift.break_start, shift.break_end),
                breakStart: breakStart.format(),
                breakEnd: breakEnd.format()
            }];
        }
        return [];
    });

    return {
        plannedDowntime: filteredPlannedDowntime,
        unplannedDowntime: filteredUnplannedDowntime,
        breaks: filteredBreaks
    };
}

function loadDataAndPrepareOEE() {
    try {
        oeeLogger.info('Loading data and preparing OEE data.');
        const processOrders = loadProcessOrderData();
        const plannedDowntime = loadPlannedDowntimeData();
        const unplannedDowntime = loadUnplannedDowntimeData();
        const shifts = loadShiftModelData();

        const processOrder = processOrders[0];
        oeeLogger.debug(`Process order details: ${JSON.stringify(processOrder, null, 2)}`);

        const durations = filterAndCalculateDurations(processOrder, plannedDowntime, unplannedDowntime, shifts);
        oeeLogger.debug(`Filtered durations: ${JSON.stringify(durations, null, 2)}`);

        const OEEData = {
            labels: [],
            datasets: [
                { label: 'Production', data: [], backgroundColor: 'green' },
                { label: 'Break', data: [], backgroundColor: 'blue' },
                { label: 'Unplanned Downtime', data: [], backgroundColor: 'red' },
                { label: 'Planned Downtime', data: [], backgroundColor: 'orange' }
            ]
        };

        let currentTime = parseDate(processOrder.Start).startOf('hour');
        const orderEnd = parseDate(processOrder.End).endOf('hour');

        oeeLogger.debug(`Rounded order start time: ${currentTime.format()}`);
        oeeLogger.debug(`Rounded order end time: ${orderEnd.format()}`);

        while (currentTime.isBefore(orderEnd)) {
            const nextTime = currentTime.clone().add(1, 'hour');

            OEEData.labels.push(currentTime.toISOString());

            let productionTime = nextTime.diff(currentTime, 'minutes');
            let breakTime = 0;
            let unplannedDowntime = 0;
            let plannedDowntime = 0;

            durations.breaks.forEach(breakInfo => {
                const breakStart = moment(breakInfo.breakStart);
                const breakEnd = moment(breakInfo.breakEnd);

                if (currentTime.isBefore(breakEnd) && nextTime.isAfter(breakStart)) {
                    const overlapStart = moment.max(currentTime, breakStart);
                    const overlapEnd = moment.min(nextTime, breakEnd);
                    breakTime += overlapEnd.diff(overlapStart, 'minutes');
                }
            });

            durations.unplannedDowntime.forEach(downtime => {
                const downtimeStart = parseDate(downtime.Start);
                const downtimeEnd = parseDate(downtime.End);
                if (currentTime.isBefore(downtimeEnd) && nextTime.isAfter(downtimeStart)) {
                    const overlapStart = moment.max(currentTime, downtimeStart);
                    const overlapEnd = moment.min(nextTime, downtimeEnd);
                    unplannedDowntime += overlapEnd.diff(overlapStart, 'minutes');
                }
            });

            durations.plannedDowntime.forEach(downtime => {
                const downtimeStart = parseDate(downtime.Start);
                const downtimeEnd = parseDate(downtime.End);
                if (currentTime.isBefore(downtimeEnd) && nextTime.isAfter(downtimeStart)) {
                    const overlapStart = moment.max(currentTime, downtimeStart);
                    const overlapEnd = moment.min(nextTime, downtimeEnd);
                    plannedDowntime += overlapEnd.diff(overlapStart, 'minutes');
                }
            });

            productionTime -= (breakTime + unplannedDowntime + plannedDowntime);

            oeeLogger.debug(`Interval ${currentTime.format("HH:mm")} - ${nextTime.format("HH:mm")}:`);
            oeeLogger.debug(`  Production time: ${productionTime} minutes`);
            oeeLogger.debug(`  Break time: ${breakTime} minutes`);
            oeeLogger.debug(`  Unplanned downtime: ${unplannedDowntime} minutes`);
            oeeLogger.debug(`  Planned downtime: ${plannedDowntime} minutes`);

            OEEData.datasets[0].data.push(productionTime);
            OEEData.datasets[1].data.push(breakTime);
            OEEData.datasets[2].data.push(unplannedDowntime);
            OEEData.datasets[3].data.push(plannedDowntime);

            currentTime = nextTime;
        }

        oeeLogger.info('OEE data prepared successfully.');
        oeeLogger.info(`OEE Data: ${JSON.stringify(OEEData)}`);

        return OEEData;
    } catch (error) {
        errorLogger.error(`Error loading or preparing OEE data: ${error.message}`);
        throw error;
    }
}

module.exports = {
    getUnplannedDowntime,
    getPlannedDowntime,
    loadProcessOrderData,
    loadUnplannedDowntimeData,
    loadPlannedDowntimeData,
    loadShiftModelData,
    loadDataAndPrepareOEE
};