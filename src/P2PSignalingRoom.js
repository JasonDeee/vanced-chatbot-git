/**
 * Vanced Customer Support - P2P Signaling Room (Durable Object)
 * Handles WebRTC signaling for P2P connections between clients and admins
 */

// ====== DEBUG CONFIGURATION ======
const P2P_DEBUG_ACTIVE = true;

/**
 * Debug logging function for P2P Signaling
 * @param {string} message - Debug message
 * @param {any} data - Optional data to log
 */
function p2pSignalingLog(message, data = null) {
	if (!P2P_DEBUG_ACTIVE) return;

	const timestamp = new Date().toISOString();
	const logMessage = `[P2P-SIGNALING ${timestamp}] ${message}`;

	if (data !== null) {
		console.log(`${logMessage}`, data);
	} else {
		console.log(logMessage);
	}
}

// ====== P2P SIGNALING ROOM DURABLE OBJECT ======
export class P2PSignalingRoom {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.sessions = new Map(); // WebSocket sessions
		this.peers = new Map(); // Peer information
		this.roomId = null;

		p2pSignalingLog('P2P Signaling Room initialized');
	}

	/**
	 * Handle HTTP requests to the Durable Object
	 */
	async fetch(request) {
		const url = new URL(request.url);

		p2pSignalingLog('Durable Object received request', {
			pathname: url.pathname,
			method: request.method,
			hasUpgrade: request.headers.get('Upgrade') === 'websocket',
		});

		// Handle WebSocket upgrade
		if (request.headers.get('Upgrade') === 'websocket') {
			return this.handleWebSocket(request);
		}

		// Handle HTTP API requests - check if path ends with /api/room-info
		if (url.pathname.endsWith('/api/room-info')) {
			return this.handleRoomInfo();
		}

		p2pSignalingLog('Path not found in Durable Object', {
			pathname: url.pathname,
			availablePaths: ['/api/room-info', 'WebSocket upgrade'],
		});

		return new Response('Not found', { status: 404 });
	}

	/**
	 * Handle WebSocket connections
	 */
	async handleWebSocket(request) {
		const url = new URL(request.url);
		const peerID = url.searchParams.get('peerID');
		const roomID = url.searchParams.get('roomID');
		const nickname = url.searchParams.get('nickname') || peerID;

		if (!peerID || !roomID) {
			return new Response('Missing peerID or roomID', { status: 400 });
		}

		// Create WebSocket pair
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		// Accept the WebSocket connection
		server.accept();

		// Store room ID
		this.roomId = roomID;

		// Setup session
		const session = {
			peerID: peerID,
			roomID: roomID,
			nickname: nickname,
			webSocket: server,
			connectedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			isAlive: true,
		};

		// Store session
		this.sessions.set(peerID, session);
		this.peers.set(peerID, {
			peerID: peerID,
			roomID: roomID,
			nickname: nickname,
			type: peerID.startsWith('admin_') ? 'admin' : 'client',
			connectedAt: session.connectedAt,
		});

		p2pSignalingLog('WebSocket connection established', {
			peerID,
			nickname,
			roomID,
			totalSessions: this.sessions.size,
		});

		// Setup WebSocket event handlers
		server.addEventListener('message', (event) => {
			this.handleWebSocketMessage(peerID, event.data);
		});

		server.addEventListener('close', () => {
			this.handleWebSocketClose(peerID);
		});

		server.addEventListener('error', (error) => {
			p2pSignalingLog('WebSocket error', { peerID, error });
			this.handleWebSocketClose(peerID);
		});

		// Send welcome message
		server.send(
			JSON.stringify({
				type: 'connected',
				peerID: peerID,
				roomID: roomID,
				nickname: nickname,
				usersInRoom: Array.from(this.peers.keys()).filter((id) => id !== peerID),
			})
		);

		// Notify other users about new connection
		this.broadcastToRoom(
			{
				type: 'user-joined',
				peerID: peerID,
				nickname: nickname,
				roomID: roomID,
			},
			peerID
		);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	/**
	 * Handle incoming WebSocket messages
	 */
	async handleWebSocketMessage(fromPeerID, messageData) {
		try {
			const message = JSON.parse(messageData);

			p2pSignalingLog('Received signaling message', {
				from: fromPeerID,
				type: message.type,
				to: message.toPeerID,
			});

			switch (message.type) {
				case 'chat-message':
					await this.handleChatMessage(fromPeerID, message);
					break;

				case 'ping':
					await this.handlePing(fromPeerID);
					break;

				case 'get-users':
					await this.sendUserList(fromPeerID);
					break;

				default:
					p2pSignalingLog('Unknown message type', {
						type: message.type,
						from: fromPeerID,
					});
			}
		} catch (error) {
			p2pSignalingLog('Error handling WebSocket message', {
				error: error.message,
				from: fromPeerID,
			});
		}
	}

	/**
	 * Handle chat messages
	 */
	async handleChatMessage(fromPeerID, message) {
		const session = this.sessions.get(fromPeerID);
		if (!session || !session.isAlive) {
			p2pSignalingLog('Chat message from inactive session', { fromPeerID });
			return;
		}

		// Update last activity
		session.lastActivity = new Date().toISOString();

		// Broadcast chat message to all other users in room
		const chatMessage = {
			type: 'chat-message',
			from: message.from || session.nickname,
			fromPeerID: fromPeerID,
			text: message.text,
			timestamp: message.timestamp || new Date().toISOString(),
			roomID: this.roomId,
		};

		this.broadcastToRoom(chatMessage, fromPeerID);

		p2pSignalingLog('Chat message broadcasted', {
			from: fromPeerID,
			nickname: session.nickname,
			textLength: message.text?.length,
			recipients: this.sessions.size - 1,
		});
	}

	/**
	 * Handle ping messages
	 */
	async handlePing(fromPeerID) {
		const session = this.sessions.get(fromPeerID);
		if (session && session.isAlive) {
			// Update last activity
			session.lastActivity = new Date().toISOString();

			session.webSocket.send(
				JSON.stringify({
					type: 'pong',
					timestamp: new Date().toISOString(),
					usersInRoom: Array.from(this.peers.keys()),
					roomID: this.roomId,
				})
			);

			p2pSignalingLog('Responded to ping', {
				fromPeerID,
				usersInRoom: this.sessions.size,
			});
		}
	}

	/**
	 * Send user list to requesting user
	 */
	async sendUserList(fromPeerID) {
		const session = this.sessions.get(fromPeerID);
		if (session && session.isAlive) {
			const userList = Array.from(this.peers.values()).map((peer) => ({
				peerID: peer.peerID,
				nickname: peer.nickname,
				type: peer.type,
				connectedAt: peer.connectedAt,
			}));

			session.webSocket.send(
				JSON.stringify({
					type: 'user-list',
					users: userList,
					roomID: this.roomId,
				})
			);
		}
	}

	/**
	 * Broadcast message to all peers in room except sender
	 */
	broadcastToRoom(message, excludePeerID = null) {
		let sentCount = 0;

		for (const [peerID, session] of this.sessions) {
			if (peerID !== excludePeerID && session.isAlive) {
				try {
					session.webSocket.send(JSON.stringify(message));
					sentCount++;
				} catch (error) {
					p2pSignalingLog('Error broadcasting to peer', {
						peerID,
						error: error.message,
					});
					this.handleWebSocketClose(peerID);
				}
			}
		}

		return sentCount;
	}

	/**
	 * Handle WebSocket connection close
	 */
	handleWebSocketClose(peerID) {
		p2pSignalingLog('WebSocket connection closed', {
			peerID,
			remainingSessions: this.sessions.size - 1,
		});

		// Remove session and peer
		this.sessions.delete(peerID);
		this.peers.delete(peerID);

		// Get nickname before removing
		const peer = this.peers.get(peerID);
		const nickname = peer?.nickname || peerID;

		// Notify other users about disconnection
		this.broadcastToRoom({
			type: 'user-left',
			peerID: peerID,
			nickname: nickname,
			roomID: this.roomId,
		});

		// If no more sessions, the Durable Object will be garbage collected
		if (this.sessions.size === 0) {
			p2pSignalingLog('All peers disconnected, room will be cleaned up', {
				roomID: this.roomId,
			});
		}
	}

	/**
	 * Handle room info API request
	 */
	async handleRoomInfo() {
		const roomInfo = {
			roomID: this.roomId,
			peersCount: this.sessions.size,
			peers: Array.from(this.peers.values()),
			createdAt: new Date().toISOString(),
		};

		// CORS headers will be added by the main worker
		return new Response(JSON.stringify(roomInfo), {
			headers: { 'Content-Type': 'application/json' },
		});
	}

	/**
	 * Cleanup inactive connections (called periodically)
	 */
	async cleanup() {
		const now = Date.now();
		const timeout = 5 * 60 * 1000; // 5 minutes

		for (const [peerID, session] of this.sessions) {
			const connectedTime = new Date(session.connectedAt).getTime();

			if (now - connectedTime > timeout && !session.isAlive) {
				p2pSignalingLog('Cleaning up inactive session', { peerID });
				this.handleWebSocketClose(peerID);
			}
		}
	}
}
