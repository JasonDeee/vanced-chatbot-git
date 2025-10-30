// Code Logic chính của Workers ở đây
import { TUNED_DATA, SYSTEM_PROMPT_TEMPLATE, SYSTEM_PROMT_SUFFIX, processTunedData } from './data.js';

import { checkBanStatus, getBanListStats } from './BanList.js';
import { P2PSignalingRoom } from './P2PSignalingRoom.js';

/**
 * Vanced Customer Support Chatbot
 * Sử dụng OpenRouter để trả lời câu hỏi khách hàng
 */

// ====== DEBUG CONFIGURATION ======
const DeBug_IsActive = true; // Set to false to disable debug logging

/**
 * Debug logging function for Workers
 * @param {string} message - Debug message
 * @param {any} data - Optional data to log
 */
function debugLog(message, data = null) {
	if (!DeBug_IsActive) return;

	const timestamp = new Date().toISOString();
	let logMessage = `[WORKERS-DEBUG ${timestamp}] ${message}`;

	if (data !== null) {
		console.log(`${logMessage}`, data);
	} else {
		console.log(logMessage);
	}
}

// Cấu hình OpenRouter API
let OPENROUTER_API_KEY;
const OPENROUTER_MODEL = 'openai/gpt-oss-20b:free';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Cấu hình Apps Script API
let APPS_SCRIPT_URL;

/**
 * Main handler cho Cloudflare Workers
 */
export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		OPENROUTER_API_KEY = env.OPENROUTER_API_KEY; // Từ environment variables
		APPS_SCRIPT_URL = env.APPS_SCRIPT_URL; // URL của Google Apps Script

		// Debug Workers runtime context
		debugLog('Workers runtime context', {
			hasEnv: !!env,
			hasCtx: !!ctx,
			ctxKeys: ctx ? Object.keys(ctx) : [],
			hasWaitUntil: ctx ? typeof ctx.waitUntil === 'function' : false,
			requestMethod: request.method,
			pathname: url.pathname,
		});

		// CORS headers
		const allowedOrigins = ['http://127.0.0.1:5500', 'https://package.vanced.media', 'https://vanced.media', 'https://beta.vanced.media'];

		const origin = request.headers.get('Origin');
		const corsHeaders = {
			'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		};

		// Handle P2P signaling requests (separate from chat API)
		if (url.pathname.startsWith('/p2p/')) {
			return handleP2PRequest(request, env, ctx, corsHeaders);
		}

		// Handle preflight request
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: corsHeaders,
			});
		}

		// Health check endpoint
		if (request.method === 'GET') {
			const stats = getBanListStats();
			const healthInfo = {
				status: 'running',
				message: 'Vanced Customer Support Bot is running!',
				banListStats: stats,
				timestamp: new Date().toISOString(),
			};

			return new Response(JSON.stringify(healthInfo), {
				headers: { ...corsHeaders, 'Content-Type': 'application/json' },
			});
		}

		// Handle POST requests
		if (request.method === 'POST') {
			try {
				const body = await request.json();
				const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';

				let response;

				// Route based on action type
				switch (body.action) {
					case 'initChat':
						response = await handleInitChat(body, clientIP, env);
						break;
					case 'sendMessage':
						response = await handleSendMessage(body, clientIP, env, ctx);
						break;
					// Legacy P2P support removed - now using Durable Objects WebSocket signaling
					default:
						// Backward compatibility - treat as sendMessage
						response = await handleSendMessage(body, clientIP, env, ctx);
				}

				return new Response(JSON.stringify(response), {
					headers: { ...corsHeaders, 'Content-Type': 'application/json' },
				});
			} catch (error) {
				console.error('Error handling request:', error);
				return new Response(
					JSON.stringify({
						error: 'Internal server error',
						message: error.message,
					}),
					{
						status: 500,
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					}
				);
			}
		}

		// Method not allowed
		return new Response('Method not allowed', {
			status: 405,
			headers: corsHeaders,
		});
	},
};

/**
 * Xử lý khởi tạo chat - Giai đoạn 1 (OnLoad)
 */
async function handleInitChat(body, clientIP, env) {
	const { fingerprint } = body;

	if (!fingerprint) {
		return {
			status: 'error',
			message: 'Browser fingerprint is required',
		};
	}

	try {
		// Generate MachineID từ fingerprint
		const machineId = await generateMachineIDFromFingerprint(fingerprint);

		// Check ban status
		const banStatus = checkBanStatus(clientIP, machineId);
		if (banStatus.isBanned) {
			return {
				status: 'banned',
				message: banStatus.message,
				reason: banStatus.reason,
			};
		}

		// Call Apps Script để khởi tạo chat session
		const appsScriptResponse = await callAppsScript(
			'initChat',
			{
				machineId: machineId,
				userIP: clientIP,
			},
			env
		);

		if (appsScriptResponse.status === 'error') {
			throw new Error(appsScriptResponse.message);
		}

		return {
			status: 'success',
			machineId: machineId,
			chatHistory: appsScriptResponse.chatHistory || [],
			userType: appsScriptResponse.status, // 'new_user' or 'existing_user'
			rpdRemaining: appsScriptResponse.rpd,
			timestamp: new Date().toISOString(),
		};
	} catch (error) {
		console.error('Error in handleInitChat:', error);
		return {
			status: 'error',
			message: 'Lỗi khởi tạo chat session',
			error: error.message,
		};
	}
}

/**
 * Xử lý gửi tin nhắn - Giai đoạn 2 (OnSubmit)
 */
async function handleSendMessage(body, clientIP, env, ctx) {
	const { message, machineId, chatHistory = [] } = body;

	if (!message || typeof message !== 'string') {
		return {
			status: 'error',
			message: 'Message is required and must be a string',
		};
	}

	if (!machineId) {
		return {
			status: 'error',
			message: 'MachineID is required',
		};
	}

	try {
		// Check ban status again
		const banStatus = checkBanStatus(clientIP, machineId);
		if (banStatus.isBanned) {
			return {
				status: 'banned',
				message: banStatus.message,
				reason: banStatus.reason,
			};
		}

		// Validate với Apps Script (rate limiting)
		const validationResponse = await callAppsScript(
			'validateChat',
			{
				machineId: machineId,
				message: message,
			},
			env
		);

		if (validationResponse.status !== 'valid') {
			return {
				status: validationResponse.status,
				message: validationResponse.message,
				rpdRemaining: validationResponse.rpdRemaining,
			};
		}

		// Chuẩn bị system prompt với dữ liệu tuned
		const processedTunedData = processTunedData(TUNED_DATA);
		const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('{TUNED_DATA}', processedTunedData) + '/n' + SYSTEM_PROMT_SUFFIX;

		// Sử dụng conversation từ Spreadsheet nếu có, fallback về chatHistory từ client
		const currentConversation = validationResponse.currentConversation || chatHistory;

		// Chuẩn bị messages cho OpenRouter
		const messages = [
			{
				role: 'system',
				content: systemPrompt,
			},
			...currentConversation.map((msg) => ({
				role: msg.role === 'assistant' ? 'assistant' : 'user',
				content: msg.content,
			})),
			{
				role: 'user',
				content: message,
			},
		];

		// Gọi OpenRouter API với structured output
		const openRouterResponse = await callOpenRouterAPI(messages, env);
		debugLog('OpenRouter API Response', {
			hasChoices: !!openRouterResponse.choices,
			choicesLength: openRouterResponse.choices?.length,
			hasContent: !!openRouterResponse.choices?.[0]?.message?.content,
			usage: openRouterResponse.usage,
			model: openRouterResponse.model,
		});

		// Validate và parse structured response
		const rawContent = openRouterResponse.choices?.[0]?.message?.content;
		debugLog('Raw content from model', {
			contentLength: rawContent?.length,
			contentPreview: rawContent,
		});

		const validation = validateStructuredResponse(rawContent);
		debugLog('Structured response validation', {
			isValid: validation.isValid,
			error: validation.error,
			hasResponseMessage: !!validation.data?.responseMessage,
			isRequestForRealPerson: validation.data?.isRequestForRealPerson,
			hasSummerize: !!validation.data?.Summerize,
		});

		if (!validation.isValid) {
			console.error('Invalid structured response:', validation.error);
			// Fallback to simple response
			return {
				status: 'success',
				response: rawContent || 'Xin lỗi, tôi không thể trả lời câu hỏi này lúc này.',
				needsHumanSupport: false,
				rpdRemaining: validationResponse.rpdRemaining,
				timestamp: new Date().toISOString(),
			};
		}

		const structuredData = validation.data;

		// Cập nhật conversation với structured response
		const newConversation = [
			...currentConversation,
			{ role: 'user', content: message },
			{ role: 'assistant', content: structuredData.responseMessage },
		];

		// Chuẩn bị response để trả về client ngay lập tức
		const finalResponse = {
			status: 'success',
			response: structuredData.responseMessage,
			needsHumanSupport: structuredData.isRequestForRealPerson,
			rpdRemaining: validationResponse.rpdRemaining,
			timestamp: new Date().toISOString(),
		};

		debugLog('Final response to client', {
			status: finalResponse.status,
			responseLength: finalResponse.response?.length,
			needsHumanSupport: finalResponse.needsHumanSupport,
			rpdRemaining: finalResponse.rpdRemaining,
		});

		// Đảm bảo async task hoàn thành với waitUntil
		if (ctx && ctx.waitUntil) {
			debugLog('Using ctx.waitUntil for async Spreadsheet update', {
				machineId,
				hasWaitUntil: typeof ctx.waitUntil === 'function',
			});

			// Tạo promise với error handling
			const asyncUpdatePromise = updateSpreadsheetAsync(machineId, newConversation, structuredData, env).catch((error) => {
				debugLog('Async update error caught in waitUntil', {
					machineId,
					error: error.message,
				});
				// Không throw để không crash Workers
				return { status: 'error', error: error.message };
			});

			ctx.waitUntil(asyncUpdatePromise);
			debugLog('ctx.waitUntil called successfully', { machineId });
		} else {
			debugLog('ctx.waitUntil not available, falling back to direct call', {
				hasCtx: !!ctx,
				ctxType: typeof ctx,
				hasWaitUntil: ctx ? typeof ctx.waitUntil : 'no ctx',
			});

			// Fallback: chờ update hoàn thành (đồng bộ)
			await updateSpreadsheetAsync(machineId, newConversation, structuredData, env);
		}

		return finalResponse;
	} catch (error) {
		console.error('Error in handleSendMessage:', error);
		return {
			status: 'error',
			message: 'Lỗi xử lý tin nhắn',
			error: error.message,
		};
	}
}

/**
 * Gọi OpenRouter API với structured output
 */
async function callOpenRouterAPI(messages, env) {
	const apiKey = env.OPENROUTER_API_KEY || OPENROUTER_API_KEY;

	if (!apiKey) {
		throw new Error('OpenRouter API key not configured');
	}

	const payload = {
		model: OPENROUTER_MODEL,
		messages: messages,
		temperature: 0.7,
		max_tokens: 1024,
		top_p: 0.95,
		response_format: {
			type: 'json_schema',
			json_schema: {
				name: 'customer_support_response',
				strict: true,
				schema: {
					type: 'object',
					properties: {
						responseMessage: {
							type: 'string',
							description: 'Response message to the user. Do not emty this field',
						},
						isRequestForRealPerson: {
							type: 'boolean',
							description: 'Whether the user is requesting to speak with a real person',
						},
						Summerize: {
							type: 'string',
							description:
								'Summary of the entire conversation, highlighting special info like Phone Number, Name, Address, Career if provided',
						},
					},
					required: ['responseMessage', 'isRequestForRealPerson', 'Summerize'],
					additionalProperties: false,
				},
			},
		},
	};

	const response = await fetch(OPENROUTER_API_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
	}

	return await response.json();
}

/**
 * Validate structured response từ OpenRouter
 */
function validateStructuredResponse(responseContent) {
	try {
		// Parse JSON nếu là string
		const parsed = typeof responseContent === 'string' ? JSON.parse(responseContent) : responseContent;

		// Validate required fields
		if (!parsed.responseMessage || typeof parsed.responseMessage !== 'string') {
			throw new Error('Missing or invalid responseMessage');
		}

		if (typeof parsed.isRequestForRealPerson !== 'boolean') {
			throw new Error('Missing or invalid isRequestForRealPerson');
		}

		// Summerize is now required
		if (!parsed.Summerize || typeof parsed.Summerize !== 'string') {
			throw new Error('Missing or invalid Summerize field');
		}

		return {
			isValid: true,
			data: {
				responseMessage: parsed.responseMessage,
				isRequestForRealPerson: parsed.isRequestForRealPerson,
				Summerize: parsed.Summerize,
			},
		};
	} catch (error) {
		return {
			isValid: false,
			error: error.message,
			data: null,
		};
	}
}

/**
 * Generate MachineID từ browser fingerprint
 */
async function generateMachineIDFromFingerprint(fingerprint) {
	const fingerprintString = JSON.stringify(fingerprint);

	// Simple hash function for MachineID
	let hash = 0;
	for (let i = 0; i < fingerprintString.length; i++) {
		const char = fingerprintString.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash; // Convert to 32-bit integer
	}

	// Convert to positive hex string (16 characters)
	return Math.abs(hash).toString(16).padStart(16, '0').substring(0, 16);
}

/**
 * Call Google Apps Script API
 */
async function callAppsScript(action, params, env) {
	const appsScriptUrl = env.APPS_SCRIPT_URL || APPS_SCRIPT_URL;

	if (!appsScriptUrl) {
		throw new Error('Apps Script URL not configured');
	}

	const url = new URL(appsScriptUrl);
	url.searchParams.append('action', action);

	// Add all params to URL
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.append(key, value);
	}

	debugLog('Calling Apps Script', { action, params, url: url.toString() });

	const response = await fetch(url.toString(), {
		method: 'GET',
		headers: {
			Accept: 'application/json',
		},
	});

	if (!response.ok) {
		const errorText = await response.text();
		debugLog('Apps Script API Error', {
			status: response.status,
			errorText,
			action,
		});
		throw new Error(`Apps Script API error: ${response.status} - ${errorText}`);
	}

	const result = await response.json();
	debugLog('Apps Script Response', {
		action,
		status: result.status,
		responseKeys: Object.keys(result),
		hasData: !!result.data,
	});

	return result;
}

/**
 * Call Google Apps Script API với POST method (fire-and-forget)
 * @param {Object} data - Data to send
 * @param {Object} env - Environment variables
 */
async function callAppsScriptPost(data, env) {
	const appsScriptUrl = env.APPS_SCRIPT_URL || APPS_SCRIPT_URL;

	if (!appsScriptUrl) {
		throw new Error('Apps Script URL not configured');
	}

	debugLog('Calling Apps Script POST', {
		action: data.action,
		machineId: data.machineId,
		conversationLength: data.conversation?.length,
		hasSummerize: !!data.summerize,
	});

	try {
		const response = await fetch(appsScriptUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(data),
		});

		debugLog('Apps Script POST Response', {
			status: response.status,
			ok: response.ok,
			statusText: response.statusText,
		});

		// Thử đọc response nếu có
		if (response.ok) {
			try {
				const result = await response.json();
				debugLog('Apps Script POST Response Body', {
					status: result.status,
					message: result.message,
				});
				return result;
			} catch (parseError) {
				debugLog('Could not parse POST response (expected for CORS)', {
					error: parseError.message,
				});
				return { status: 'posted', message: 'Data sent successfully' };
			}
		} else {
			debugLog('Apps Script POST Error', {
				status: response.status,
				statusText: response.statusText,
			});
			return { status: 'error', message: `HTTP ${response.status}` };
		}
	} catch (error) {
		debugLog('Apps Script POST Network Error', {
			error: error.message,
			name: error.name,
		});

		// Network errors có thể do CORS, nhưng data vẫn có thể đã được gửi
		return {
			status: 'network_error',
			message: 'Network error (data may still be processed)',
			error: error.message,
		};
	}
}

/**
 * Cập nhật Spreadsheet bất đồng bộ - không chờ kết quả
 * @param {string} machineId - MachineID
 * @param {Array} newConversation - Conversation mới
 * @param {Object} structuredData - Dữ liệu từ model
 * @param {Object} env - Environment variables
 */
async function updateSpreadsheetAsync(machineId, newConversation, structuredData, env) {
	const startTime = Date.now();

	try {
		debugLog('Starting async Spreadsheet update', {
			machineId,
			conversationLength: newConversation.length,
			hasSummerize: !!structuredData.Summerize,
			needsHumanSupport: structuredData.isRequestForRealPerson,
			timestamp: new Date().toISOString(),
		});

		// Timeout protection - Apps Script có thể mất 5-10 giây
		const timeoutPromise = new Promise((_, reject) => {
			setTimeout(() => reject(new Error('Spreadsheet update timeout')), 15000);
		});

		// Gọi update với POST method
		const updatePromise = callAppsScriptPost(
			{
				action: 'updateAll',
				machineId: machineId,
				conversation: JSON.stringify(newConversation),
				summerize: structuredData.Summerize || '',
				needsHumanSupport: structuredData.isRequestForRealPerson,
			},
			env
		);

		// Race giữa update và timeout
		const batchResult = await Promise.race([updatePromise, timeoutPromise]);

		const duration = Date.now() - startTime;
		debugLog('Async Spreadsheet update completed', {
			machineId,
			status: batchResult.status,
			results: batchResult.results,
			hasErrors: batchResult.status !== 'success',
			duration: `${duration}ms`,
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		const duration = Date.now() - startTime;

		// Chỉ log lỗi, không throw để không ảnh hưởng response đã trả về client
		debugLog('Error in async Spreadsheet update', {
			machineId,
			error: error.message,
			errorType: error.name,
			duration: `${duration}ms`,
			timestamp: new Date().toISOString(),
			isTimeout: error.message.includes('timeout'),
		});

		console.error('Async Spreadsheet update failed:', error);

		// Return error object để có thể track trong waitUntil
		return {
			status: 'error',
			error: error.message,
			duration,
			machineId,
		};
	}
}

/**
 * Handle P2P signaling requests (separate from chat API for low latency)
 */
async function handleP2PRequest(request, env, ctx, corsHeaders) {
	const url = new URL(request.url);

	debugLog('P2P request received', {
		pathname: url.pathname,
		method: request.method,
		hasWebSocketUpgrade: request.headers.get('Upgrade') === 'websocket',
	});

	// Handle preflight requests for P2P endpoints
	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: corsHeaders,
		});
	}

	try {
		// Extract room ID from URL path: /p2p/room/{roomID}
		const pathParts = url.pathname.split('/');
		if (pathParts.length < 4 || pathParts[1] !== 'p2p' || pathParts[2] !== 'room') {
			return new Response('Invalid P2P path. Use /p2p/room/{roomID}', {
				status: 400,
				headers: corsHeaders,
			});
		}

		const roomID = pathParts[3];
		if (!roomID) {
			return new Response('Room ID is required', {
				status: 400,
				headers: corsHeaders,
			});
		}

		// Get Durable Object instance for this room
		const durableObjectId = env.P2P_SIGNALING_ROOM.idFromName(roomID);
		const durableObject = env.P2P_SIGNALING_ROOM.get(durableObjectId);

		// Forward request to Durable Object
		const response = await durableObject.fetch(request);

		debugLog('P2P request forwarded to Durable Object', {
			roomID,
			status: response.status,
			hasWebSocket: !!response.webSocket,
		});

		// If it's a WebSocket upgrade, return as-is
		if (response.webSocket) {
			return response;
		}

		// For regular HTTP responses, add CORS headers
		const responseHeaders = new Headers(response.headers);

		// Add CORS headers
		Object.entries(corsHeaders).forEach(([key, value]) => {
			responseHeaders.set(key, value);
		});

		const newResponse = new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: responseHeaders,
		});

		return newResponse;
	} catch (error) {
		debugLog('Error handling P2P request', {
			error: error.message,
			pathname: url.pathname,
		});

		return new Response(
			JSON.stringify({
				error: 'P2P signaling error',
				message: error.message,
			}),
			{
				status: 500,
				headers: {
					...corsHeaders,
					'Content-Type': 'application/json',
				},
			}
		);
	}
}

// Export Durable Object class
export { P2PSignalingRoom };
