import { loadConfig } from '@oneunit/microservice';
const config = loadConfig('./config.json');
console.log('rootKey:', config.crypto.rootKey);
console.log('rootKey length:', config.crypto.rootKey.length);