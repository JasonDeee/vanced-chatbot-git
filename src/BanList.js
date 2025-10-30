/**
 * Ban List Management for Vanced Customer Support Chatbot
 * Danh sách ban cứng - cập nhật thủ công khi cần thiết
 */

/**
 * Danh sách IP bị ban vĩnh viễn
 * Format: ["IP_ADDRESS", "IP_ADDRESS", ...]
 */
export const BANNED_IPS = [
    // Thêm IP cần ban vào đây
    // "192.168.1.100",
    // "10.0.0.50",
    // "203.113.xxx.xxx"
  ];
  
  /**
   * Danh sách MachineID bị ban vĩnh viễn
   * Format: ["MACHINE_ID", "MACHINE_ID", ...]
   */
  export const BANNED_MACHINE_IDS = [
    // Thêm MachineID cần ban vào đây
    // "abc123def456789a",
    // "xyz789abc123def4",
    // "spam001malicious"
  ];
  
  /**
   * Kiểm tra IP có bị ban không
   * @param {string} ip - IP address cần kiểm tra
   * @returns {boolean} - true nếu bị ban
   */
  export function isIPBanned(ip) {
    if (!ip || typeof ip !== "string") return false;
    return BANNED_IPS.includes(ip.trim());
  }
  
  /**
   * Kiểm tra MachineID có bị ban không
   * @param {string} machineId - MachineID cần kiểm tra
   * @returns {boolean} - true nếu bị ban
   */
  export function isMachineIdBanned(machineId) {
    if (!machineId || typeof machineId !== "string") return false;
    return BANNED_MACHINE_IDS.includes(machineId.trim());
  }
  
  /**
   * Kiểm tra tổng hợp ban status
   * @param {string} ip - IP address
   * @param {string} machineId - MachineID
   * @returns {Object} - {isBanned: boolean, reason: string}
   */
  export function checkBanStatus(ip, machineId) {
    if (isIPBanned(ip)) {
      return {
        isBanned: true,
        reason: "IP_BANNED",
        message: "Thiết bị này không hợp lệ!",
      };
    }
  
    if (isMachineIdBanned(machineId)) {
      return {
        isBanned: true,
        reason: "MACHINE_ID_BANNED",
        message: "Thiết bị này không hợp lệ!",
      };
    }
  
    return {
      isBanned: false,
      reason: null,
      message: null,
    };
  }
  
  /**
   * Thống kê ban list (cho debugging)
   */
  export function getBanListStats() {
    return {
      bannedIPs: BANNED_IPS.length,
      bannedMachineIds: BANNED_MACHINE_IDS.length,
      totalBanned: BANNED_IPS.length + BANNED_MACHINE_IDS.length,
      lastUpdated: new Date().toISOString(),
    };
  }
  