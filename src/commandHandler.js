const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const { oeeLogger, errorLogger } = require('../utils/logger');
const { loadProcessOrderData, loadMachineStoppagesData } = require('../src/dataLoader');
const config = require('../config/config'); // Import the config
const { setWebSocketServer, sendWebSocketMessage } = require('./webSocketUtils'); // Import WebSocket utilities

dotenv.config(); // Load environment variables from .env file

let currentHoldStatus = {};
let processOrderData = null;

// Use the threshold value from the config
const THRESHOLD_SECONDS = config.thresholdSeconds;

// Path to the Microstops.json file
const dbFilePath = path.join(__dirname, '../data/machineStoppages.json');

// Load environment variables
const DATE_FORMAT = process.env.DATE_FORMAT || 'YYYY-MM-DDTHH:mm:ss.SSSZ';
const TIMEZONE = process.env.TIMEZONE || 'Europe/Berlin'; // Europe/Berlin wird sowohl für CET als auch für CEST verwendet

/**
 * Parse a date string into a Moment.js object and convert it to CEST.
 * @param {string} dateStr - The date string.
 * @returns {Object} Moment.js object.
 */
function parseDate(dateStr) {
    const date = moment.tz(dateStr, TIMEZONE);
    if (!date.isValid()) {
        const errorMsg = `Invalid date: ${dateStr}`;
        errorLogger.error(errorMsg);
        throw new Error(errorMsg);
    }
    return date;
}

/**
 * Load and convert machine stoppages data from JSON.
 * @returns {Array} The machine stoppages data with converted timestamps.
 */
function loadAndConvertMachineStoppagesData() {
    try {
        const data = fs.readFileSync(dbFilePath, 'utf8');
        const machineStoppages = JSON.parse(data);

        return machineStoppages.map(stoppage => ({
            ...stoppage,
            Start: moment.tz(stoppage.Start, 'UTC').format(DATE_FORMAT),
            End: moment.tz(stoppage.End, 'UTC').format(DATE_FORMAT)
        }));
    } catch (error) {
        errorLogger.error(`Failed to load and convert machine stoppages data: ${error.message}`);
        throw error;
    }
}

// Try to load process order data on module start
try {
    processOrderData = loadProcessOrderData();
    oeeLogger.info(`Process order data loaded: ${JSON.stringify(processOrderData)}`);
    if (processOrderData && processOrderData.length > 0) {
        oeeLogger.info(`Loaded ProcessOrderNumber: ${processOrderData[0].ProcessOrderNumber}`);
    } else {
        oeeLogger.warn('Process order data is empty or undefined.');
    }
} catch (error) {
    errorLogger.error(`Failed to load process order data: ${error.message}`);
}

// Send initial machine stoppages data to WebSocket clients
try {
    const initialMicrostops = loadAndConvertMachineStoppagesData();
    sendWebSocketMessage('Microstops', initialMicrostops);
} catch (error) {
    errorLogger.error(`Failed to load initial machine stoppages data: ${error.message}`);
}

// Handle Hold command
function handleHoldCommand(value) {
    const timestamp = moment().tz(TIMEZONE).toISOString();

    oeeLogger.debug(`handleHoldCommand called with value: ${value}`);

    if (value === 1) {
        oeeLogger.info('Machine is on Hold');
        stopMachineOperations();
        logEventToDatabase('Hold', timestamp);
        notifyPersonnel('Machine has been put on hold.');

        const processOrderNumber = processOrderData && processOrderData[0] && processOrderData[0].ProcessOrderNumber;
        if (processOrderNumber) {
            if (!currentHoldStatus[processOrderNumber]) {
                currentHoldStatus[processOrderNumber] = [];
            }
            currentHoldStatus[processOrderNumber].push({ timestamp });

            console.log(`Hold signal recorded in Microstops.json at ${timestamp}`);
        } else {
            oeeLogger.warn('No valid process order data found. Hold signal ignored.');
        }
    } else {
        oeeLogger.info('Hold command received, but value is not 1');
    }
}

// Handle Unhold command
function handleUnholdCommand(value) {
    const timestamp = moment().tz(TIMEZONE).toISOString();

    oeeLogger.debug(`handleUnholdCommand called with value: ${value}`);

    if (value === 1) {
        const processOrderNumber = processOrderData && processOrderData[0] && processOrderData[0].ProcessOrderNumber;
        const order_id = processOrderData && processOrderData[0] && processOrderData[0].order_id;

        if (processOrderNumber && order_id) {
            if (currentHoldStatus[processOrderNumber] && currentHoldStatus[processOrderNumber].length > 0) {
                oeeLogger.info('Machine is now Unhold');
                startMachineOperations();
                logEventToDatabase('Unhold', timestamp);
                notifyPersonnel('Machine has been unhold and resumed operations.');

                const holdTimestamp = parseDate(currentHoldStatus[processOrderNumber][currentHoldStatus[processOrderNumber].length - 1].timestamp);
                const unholdTimestamp = parseDate(timestamp);

                oeeLogger.debug(`holdTimestamp: ${holdTimestamp}`);
                oeeLogger.debug(`unholdTimestamp: ${unholdTimestamp}`);

                const downtimeSeconds = Math.round(unholdTimestamp.diff(holdTimestamp, 'seconds'));

                oeeLogger.debug(`Calculated downtimeSeconds: ${downtimeSeconds}`);

                if (downtimeSeconds >= THRESHOLD_SECONDS) {
                    // In deiner Funktion, z.B. in handleUnholdCommand
                    const machineStoppageEntry = {
                        "ID": uuidv4(), // Generiert eine einzigartige ID
                        "ProcessOrderID": order_id,
                        "ProcessOrderNumber": processOrderNumber,
                        "Start": holdTimestamp.toISOString(),
                        "End": unholdTimestamp.toISOString(),
                        "Reason": "tbd",
                        "Differenz": downtimeSeconds
                    };

                    try {
                        let Microstops = [];
                        if (fs.existsSync(dbFilePath)) {
                            const MicrostopsContent = fs.readFileSync(dbFilePath, 'utf8');
                            try {
                                Microstops = JSON.parse(MicrostopsContent);
                            } catch (jsonError) {
                                oeeLogger.warn('Microstops.json is empty or invalid. Initializing with an empty array.');
                                Microstops = [];
                            }
                        }

                        Microstops.push(machineStoppageEntry);

                        fs.writeFileSync(dbFilePath, JSON.stringify(Microstops, null, 2), 'utf8');
                        console.log(`Unhold signal recorded in Microstops.json at ${timestamp}`);
                        console.log(`Downtime for Order ${processOrderNumber}: ${downtimeSeconds} seconds`);

                        // Senden der aktualisierten Maschinendaten an WebSocket-Clients
                        sendWebSocketMessage('Microstops', Microstops);

                    } catch (error) {
                        console.error('Error writing Microstops.json:', error.message);
                    }
                } else {
                    oeeLogger.info(`Downtime of ${downtimeSeconds} seconds did not meet the threshold of ${THRESHOLD_SECONDS} seconds. No entry recorded.`);
                }

                currentHoldStatus[processOrderNumber].pop();

                if (currentHoldStatus[processOrderNumber].length === 0) {
                    delete currentHoldStatus[processOrderNumber];
                }
            } else {
                oeeLogger.info('Unhold command received, but no previous Hold signal found.');
                console.log('Current Hold Status:', currentHoldStatus);
            }
        } else {
            oeeLogger.warn('No valid process order data found. Unhold signal ignored.');
        }
    } else {
        oeeLogger.info('Unhold command received, but value is not 1');
    }
}

// Function to stop machine operations
function stopMachineOperations() {
    oeeLogger.info('Stopping machine operations...');
}

// Function to start machine operations
function startMachineOperations() {
    oeeLogger.info('Starting machine operations...');
}

// Function to log events to the database
function logEventToDatabase(event, timestamp) {
    try {
        if (!event || !timestamp) {
            throw new Error('Event or timestamp missing or invalid.');
        }

        oeeLogger.info(`Logging event to database: ${event} at ${timestamp}`);
    } catch (error) {
        errorLogger.error(`Error logging event to database: ${error.message}`);
    }
}

// Function to notify personnel
function notifyPersonnel(message) {
    oeeLogger.info(`Notifying personnel: ${message}`);
}

// Export the functions to be used in other modules
module.exports = { handleHoldCommand, handleUnholdCommand, setWebSocketServer };