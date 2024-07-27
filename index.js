const express = require('express');
const path = require('path');
const cron = require('node-cron');
const dotenv = require('dotenv');
const { Server } = require('ws'); // WebSocket Server
const {
    loadMachineStoppagesData,
    saveMachineStoppageData,
    getMachineStoppagesCache
} = require('./src/dataLoader'); // Import the necessary functions

dotenv.config();

const { defaultLogger, errorLogger } = require('./utils/logger');
const { logRetentionDays, ratings } = require('./config/config'); // Import ratings from config
const { setupMqttClient } = require('./src/mqttClient');
const { handleErrors } = require('./utils/middleware');
const { setWebSocketServer } = require('./src/oeeProcessor'); // Import WebSocket setter

const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse incoming JSON and URL-encoded payloads
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from the 'public' directory

// Serve index.html at the root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint to get timezone from .env
app.get('/timezone', (req, res) => {
    res.send(process.env.TIMEZONE || 'UTC');
});

// Endpoint to get rating labels
app.get('/ratings', (req, res) => {
    res.json(ratings);
});

// Endpoint to rate a stoppage
app.post('/rate', (req, res) => {
    const { id, rating } = req.body;
    saveRating(id, rating, (error, updatedStoppages) => {
        if (error) {
            errorLogger.error(`Error in /rate endpoint: ${error.message}`);
            return res.status(500).send(error.message);
        }
        res.json(updatedStoppages);
    });
});

// Define routes for different functionalities
app.use('/structure', require('./routes/structure'));
app.use('/oee-logs', require('./routes/oeeLogs'));
app.use('/calculateOEE', require('./routes/calculateOEE'));

// Error handling middleware
app.use(handleErrors);

defaultLogger.info('Logger initialized successfully.');

// Schedule a cron job to clean up old logs daily at midnight
cron.schedule('0 0 * * *', async() => {
    try {
        const { cleanupLogs } = require('./utils/logger');
        await cleanupLogs(logRetentionDays);
        defaultLogger.info('Old logs cleanup job completed successfully.');
    } catch (error) {
        errorLogger.error('Error during log cleanup job:', error.message);
    }
});

// Initialize and set up the MQTT client
let mqttClient;
try {
    mqttClient = setupMqttClient();
    defaultLogger.info('MQTT client initialized successfully.');
} catch (error) {
    errorLogger.error('Error initializing MQTT client:', error.message);
}

// Start the HTTP server and listen on the specified port
const server = app.listen(port, () => {
    defaultLogger.info(`Server is running on port ${port}`);
});

// Secret key for JWT
const SECRET_KEY = 'your_secret_key'; // Replace with your secret key

// Initialize WebSocket server
const wss = new Server({ server });

wss.on('connection', (ws, req) => {
    defaultLogger.info('WebSocket connection established');

    ws.on('message', (message) => {
        const parsedMessage = JSON.parse(message);
        defaultLogger.info(`Received message: ${message}`);

        if (parsedMessage.type === 'updateRating') {
            const { ProcessOrderID, ID, Reason } = parsedMessage.data;
            saveRating(ProcessOrderID, ID, Reason, (error, updatedStoppages) => {
                if (error) {
                    errorLogger.error(`Error saving rating: ${error.message}`);
                    return;
                }

                // Broadcast the updated data to all connected clients
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'Microstops', data: updatedStoppages }));
                    }
                });
            });
        }
    });

    ws.on('close', () => {
        defaultLogger.info('WebSocket connection closed');
    });
});

// Function to save rating
function saveRating(processOrderId, id, rating, callback) {
    const machineStoppages = getMachineStoppagesCache();

    const stoppage = machineStoppages.find(stoppage => stoppage.ID === id);
    if (stoppage) {
        stoppage.Reason = rating;
        saveMachineStoppageData(machineStoppages, (error) => {
            if (error) {
                errorLogger.error(`Error saving machine stoppage data: ${error.message}`);
                return callback(error);
            }
            defaultLogger.info(`Rating for stoppage ID ${processOrderId} updated to ${rating}`);
            callback(null, machineStoppages);
        });
    } else {
        const error = new Error(`Stoppage with ID ${id} not found`);
        errorLogger.error(error.message);
        callback(error);
    }
}

// Set the WebSocket server instance in oeeProcessor
setWebSocketServer(wss);

// Function to handle graceful shutdown of the server
function gracefulShutdown(signal) {
    defaultLogger.info(`${signal} signal received: closing HTTP server`);
    server.close(() => {
        defaultLogger.info('HTTP server closed');
        if (mqttClient) {
            mqttClient.end(() => {
                defaultLogger.info('MQTT client disconnected');
                process.exit(0);
            });
        } else {
            process.exit(0);
        }
    });
}

// Listen for termination signals to gracefully shut down the server
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));