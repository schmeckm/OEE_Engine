const WebSocket = require('ws');
const { oeeLogger, errorLogger } = require('../utils/logger');
const { loadMachineStoppagesData } = require('../src/dataLoader');

let wsServer = null; // Rename to avoid conflict with frontend

/**
 * Set the WebSocket server instance.
 * @param {Object} server - The WebSocket server instance.
 */
function setWebSocketServer(server) {
    wsServer = server;
    wsServer.on('connection', async(ws) => {
        console.log('Client connected');

        // Send initial machine stoppages data to the newly connected client
        try {
            const machineStoppagesData = loadMachineStoppagesData();
            sendWebSocketMessage('Microstops', machineStoppagesData);
            oeeLogger.info('Initial machine stoppages data sent to WebSocket client.');
        } catch (error) {
            errorLogger.error(`Error sending initial machine stoppages data: ${error.message}`);
        }

        ws.on('close', () => {
            console.log('Client disconnected');
        });
    });
}

/**
 * Send data to all connected WebSocket clients with a specified type.
 * @param {string} type - The type of data being sent.
 * @param {Object} data - The data to send.
 */
function sendWebSocketMessage(type, data) {
    if (wsServer) {
        const payload = JSON.stringify({ type, data });
        wsServer.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
        oeeLogger.info(`${type} data sent to WebSocket clients.`);
    }
}

module.exports = {
    setWebSocketServer,
    sendWebSocketMessage
};