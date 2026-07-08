import { query } from '../db.js';

/**
 * Log an activity to the activity_log table
 * @param {number} userId - Who performed the action
 * @param {string} action - Action type (generation, login, asset_upload, project_create, employee_invite, etc.)
 * @param {string} [entityType] - Type of entity (generation, project, asset, user)
 * @param {number} [entityId] - ID of the entity
 * @param {object} [details] - Additional details as JSON
 */
export async function logActivity(userId, action, entityType = null, entityId = null, details = {}) {
  try {
    await query(
      'INSERT INTO activity_log (user_id, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
      [userId, action, entityType, entityId, JSON.stringify(details)]
    );
  } catch (e) {
    console.error('Activity log error:', e);
  }
}
