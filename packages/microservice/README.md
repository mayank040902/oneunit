# @oneunit/microservice

Secure, multi-protocol communication server for microservices. Enables encrypted data exchange between services using TCP, UDP, and RPC protocols with end-to-end encryption.

## Architecture

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed design documentation.

## Features

- **Multi-Protocol**: TCP (reliable), UDP (low-latency), RPC (structured)
- **End-to-End Encryption**: AES-256-GCM / ChaCha20-Poly1305
- **Key Exchange**: X25519 ECDH for perfect forward secrecy
- **Authentication**: Ed25519 signatures for message integrity
- **Service Registry**: Built-in discovery with health checks
- **Authorization**: Allowlist-based access control with rate limiting
- **Transport Abstraction**: Pluggable transport layer

## Installation

```bash
npm install @oneunit/microservice
```

## Quick Start

```typescript
import { createServer, loadConfig } from '@oneunit/microservice';

const config = loadConfig('./config.json');
const server = createServer(config);

await server.start();
console.log('Server running on', config.protocols.tcp.port);
```

## Configuration

See `config.example.json` for all options. Key sections:

- `protocols.tcp/udp/rpc` - Port and TLS settings
- `crypto.rootKey` - Base64-encoded master key (32+ bytes)
- `registry.backend` - 'memory' or 'redis'
- `auth.allowlist` - Authorized services

## Protocols

### TCP
- Length-prefixed framing
- TLS 1.3 support
- Connection pooling

### UDP
- Datagram with optional reliability
- Multicast support
- Fragmentation for large messages

### RPC
- JSON-RPC 2.0 compatible
- Schema validation with Zod
- Streaming responses

## Security Model

1. Services register with Ed25519 public key
2. Session keys derived via X25519 ECDH
3. Messages encrypted with AES-256-GCM
4. Each message signed by sender
5. Receiver verifies signature before decryption
6. Automatic key rotation

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint
```

## License

MIT