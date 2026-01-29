/**
 * @fileoverview HTTP Server - Legacy Entry Point
 * 
 * This file maintains backward compatibility.
 * Implementation has moved to http/ module.
 * 
 * @deprecated Import from './http' instead
 * @module httpServer
 */

// Re-export from new modular location
export { startHttpServer as startHttp, startHttpServerAsync } from './http';
