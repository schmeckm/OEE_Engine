const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
require('dotenv').config(); // Load the .env file

const logFormat = winston.format.printf(({ level, message, timestamp, ...metadata }) => {
    let logMessage = `${timestamp} ${level}: ${message}`;
    if (Object.keys(metadata).length) {
        logMessage += `\n${JSON.stringify(metadata, null, 2)}`;
    }
    return logMessage;
});

const logLevels = (process.env.LOG_LEVELS || 'debug').split(',').map(level => level.trim());
const retentionDays = process.env.LOG_RETENTION_DAYS || 14;
const logToConsole = process.env.LOG_TO_CONSOLE === 'true';
const logToFile = process.env.LOG_TO_FILE === 'true';

const customFilter = winston.format((info) => logLevels.includes(info.level) ? info : false);

const createLogger = (logFilename) => {
    const logDirectory = path.join(__dirname, '../logs');
    const transports = [];

    if (logToConsole) {
        transports.push(new winston.transports.Console({
            format: winston.format.combine(
                customFilter(),
                winston.format.colorize(),
                winston.format.timestamp(),
                logFormat
            )
        }));
    }

    if (logToFile) {
        transports.push(new DailyRotateFile({
            filename: path.join(logDirectory, `${logFilename}-%DATE%.log`),
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: `${retentionDays}d`,
            format: winston.format.combine(
                customFilter(),
                winston.format.timestamp(),
                logFormat
            )
        }));
    }

    return winston.createLogger({
        level: 'debug',
        format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
        ),
        transports,
        exceptionHandlers: [
            new DailyRotateFile({
                filename: path.join(logDirectory, 'exceptions-%DATE%.log'),
                datePattern: 'YYYY-MM-DD',
                maxSize: '20m',
                maxFiles: `${retentionDays}d`,
                format: winston.format.combine(
                    customFilter(),
                    winston.format.timestamp(),
                    logFormat
                )
            })
        ],
        rejectionHandlers: [
            new DailyRotateFile({
                filename: path.join(logDirectory, 'rejections-%DATE%.log'),
                datePattern: 'YYYY-MM-DD',
                maxSize: '20m',
                maxFiles: `${retentionDays}d`,
                format: winston.format.combine(
                    customFilter(),
                    winston.format.timestamp(),
                    logFormat
                )
            })
        ]
    });
};

const oeeLogger = createLogger('oee');
const errorLogger = createLogger('error');
const defaultLogger = createLogger('app');
const unplannedDowntimeLogger = createLogger('unplannedDowntime');

module.exports = {
    oeeLogger,
    errorLogger,
    defaultLogger,
    unplannedDowntimeLogger
};