export { KafkaTransport, createKafkaTransport } from './adapter.js';
export { 
  createKafkaClient, 
  isKafkaAvailable, 
  resetKafkaClient, 
  getCachedKafkaClient,
  type KafkaClient,
  type KafkaClientConfig 
} from './kafka-client.js';