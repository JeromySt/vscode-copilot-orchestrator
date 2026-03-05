/**
 * @fileoverview Bulk operations implementation for multi-select plan actions.
 * 
 * Handles executing actions (delete, cancel, pause, resume, retry, finalize)
 * on multiple plans simultaneously with individual error handling.
 * 
 * @module plan/bulkPlanActions
 */

import { Logger } from '../core/logger';
import type { IBulkPlanActions, BulkActionType, BulkActionResult } from '../interfaces/IBulkPlanActions';
import type { IPlanRunner } from '../interfaces/IPlanRunner';
import type { IDialogService } from '../interfaces/IDialogService';

const log = Logger.for('ui');

export class BulkPlanActions implements IBulkPlanActions {
  constructor(
    private readonly _planRunner: IPlanRunner,
    private readonly _dialog: IDialogService
  ) {}

  async executeBulkAction(action: BulkActionType, planIds: string[]): Promise<BulkActionResult[]> {
    log.info('Executing bulk action', { action, planCount: planIds.length, planIds });
    const results: BulkActionResult[] = [];
    
    for (const planId of planIds) {
      try {
        switch (action) {
          case 'delete': {
            const ok = this._planRunner.delete(planId);
            results.push({ planId, success: ok, error: ok ? undefined : 'Delete failed' });
            break;
          }
          case 'cancel': {
            const ok = this._planRunner.cancel(planId);
            results.push({ planId, success: ok, error: ok ? undefined : 'Cancel failed' });
            break;
          }
          case 'pause': {
            const ok = this._planRunner.pause(planId);
            results.push({ planId, success: ok, error: ok ? undefined : 'Pause failed' });
            break;
          }
          case 'resume': {
            const ok = await this._planRunner.resume(planId);
            results.push({ planId, success: ok, error: ok ? undefined : 'Resume failed' });
            break;
          }
          case 'retry': {
            const plan = this._planRunner.get(planId);
            if (!plan) { 
              results.push({ planId, success: false, error: 'Plan not found' }); 
              break; 
            }
            const ok = await this._planRunner.resume(planId);
            results.push({ planId, success: ok, error: ok ? undefined : 'Retry failed' });
            break;
          }
          case 'finalize': {
            results.push({ planId, success: false, error: 'Finalize not supported in bulk yet' });
            break;
          }
        }
      } catch (err: any) {
        log.error('Bulk action failed for plan', { action, planId, error: err.message });
        results.push({ planId, success: false, error: err.message });
      }
    }
    
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    log.info('Bulk action completed', { action, succeeded, failed, total: planIds.length });
    
    return results;
  }

  getValidActions(planIds: string[]): Map<BulkActionType, boolean> {
    const actions = new Map<BulkActionType, boolean>();
    
    // delete: always valid
    actions.set('delete', true);
    
    // For other actions, check if ANY plan meets the criteria
    let hasRunning = false;
    let hasPaused = false;
    let hasFailed = false;
    let hasScaffolding = false;
    let hasPending = false;
    
    for (const planId of planIds) {
      const plan = this._planRunner.get(planId);
      if (!plan) continue;
      
      const statusInfo = this._planRunner.getStatus(planId);
      if (!statusInfo) continue;
      
      const { status } = statusInfo;
      
      // Check various states
      if (status === 'running' || status === 'pausing') {
        hasRunning = true;
      }
      if (status === 'paused') {
        hasPaused = true;
      }
      if (status === 'failed' || status === 'partial') {
        hasFailed = true;
      }
      if (status === 'scaffolding') {
        hasScaffolding = true;
      }
      if (status === 'pending' || status === 'pending-start') {
        hasPending = true;
      }
    }
    
    // cancel: valid if ANY plan is running or pending
    actions.set('cancel', hasRunning || hasPending);
    
    // pause: valid if ANY plan is running
    actions.set('pause', hasRunning);
    
    // resume: valid if ANY plan is paused
    actions.set('resume', hasPaused);
    
    // retry: valid if ANY plan has failed
    actions.set('retry', hasFailed);
    
    // finalize: valid if ANY plan is in scaffolding state
    actions.set('finalize', hasScaffolding);
    
    return actions;
  }
}
