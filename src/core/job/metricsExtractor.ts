/**
 * @fileoverview Metrics Extraction - Extract test and build metrics from job logs.
 * 
 * Single responsibility: Parse job logs to extract quantitative metrics.
 * 
 * @module core/job/metricsExtractor
 */

import * as fs from 'fs';
import { Logger, ComponentLogger } from '../logger';
import { Job, JobMetrics } from './types';

const log: ComponentLogger = Logger.for('jobs');

/**
 * Test result patterns for various frameworks.
 */
const TEST_PATTERNS = [
  // NUnit: "Total tests: 47, Passed: 45, Failed: 2"
  // dotnet test: "Total tests: 47, Passed: 45, Failed: 2"
  /Total tests?:\s*(\d+).*?Passed:\s*(\d+).*?Failed:\s*(\d+)/i,
  
  // Jest: "Tests: 45 passed, 2 failed"
  /Tests?:\s*(\d+)\s*passed.*?(\d+)\s*failed/i,
  
  // NUnit/xUnit: "Passed: 45, Failed: 2"
  /Passed:\s*(\d+).*?Failed:\s*(\d+)/i,
  
  // Generic: "45 tests passed, 2 failed"
  /(\d+)\s*tests?\s*passed.*?(\d+)\s*failed/i,
  
  // Mocha: "45 passing, 2 failing"
  /(\d+)\s*passing.*?(\d+)\s*failing/i,
];

/**
 * Coverage patterns for various frameworks.
 */
const COVERAGE_PATTERNS = [
  // "Coverage: 85.5%", "Line coverage: 85.5%", "Branch coverage: 85.5%"
  /(?:coverage|line coverage|branch coverage):\s*([\d.]+)%/i,
  
  // "85.5% coverage", "85.5% covered"
  /([\d.]+)%\s*(?:coverage|covered)/i,
  
  // "coverage is 85.5%"
  /coverage\s+is\s+([\d.]+)%/i,
  
  // Istanbul/nyc: "All files | 85.5 |"
  /All files\s*\|\s*([\d.]+)\s*\|/i,
];

/**
 * Build error/warning patterns.
 */
const ERROR_PATTERN = /(\d+)\s*error(?:s|\(s\))?/i;
const WARNING_PATTERN = /(\d+)\s*warning(?:s|\(s\))?/i;

/**
 * Extract metrics from a job's log file.
 */
export function extractMetricsFromLog(job: Job): JobMetrics {
  const metrics: JobMetrics = {};

  if (!job.logFile) return metrics;

  try {
    const logContent = fs.readFileSync(job.logFile, 'utf-8');
    
    // Extract test counts
    extractTestMetrics(logContent, metrics);
    
    // Extract coverage percentage
    extractCoverageMetrics(logContent, metrics);
    
    // Extract build errors/warnings
    extractBuildMetrics(logContent, metrics);
    
    if (Object.keys(metrics).length > 0) {
      log.debug(`Extracted metrics from job log`, { jobId: job.id, metrics });
    }
  } catch (e: any) {
    log.debug(`Could not read job log for metrics extraction`, { 
      jobId: job.id, 
      error: e.message 
    });
  }

  return metrics;
}

/**
 * Extract test metrics from log content.
 */
function extractTestMetrics(logContent: string, metrics: JobMetrics): void {
  for (const pattern of TEST_PATTERNS) {
    const match = logContent.match(pattern);
    if (match) {
      if (match.length === 4) {
        // Pattern with total, passed, failed
        metrics.testsRun = parseInt(match[1], 10);
        metrics.testsPassed = parseInt(match[2], 10);
        metrics.testsFailed = parseInt(match[3], 10);
      } else if (match.length === 3) {
        // Pattern with passed, failed only
        metrics.testsPassed = parseInt(match[1], 10);
        metrics.testsFailed = parseInt(match[2], 10);
        metrics.testsRun = (metrics.testsPassed || 0) + (metrics.testsFailed || 0);
      }
      break; // Stop after first match
    }
  }
}

/**
 * Extract coverage metrics from log content.
 */
function extractCoverageMetrics(logContent: string, metrics: JobMetrics): void {
  for (const pattern of COVERAGE_PATTERNS) {
    const match = logContent.match(pattern);
    if (match) {
      metrics.coveragePercent = parseFloat(match[1]);
      break; // Stop after first match
    }
  }
}

/**
 * Extract build error/warning metrics from log content.
 */
function extractBuildMetrics(logContent: string, metrics: JobMetrics): void {
  const errorMatch = logContent.match(ERROR_PATTERN);
  const warningMatch = logContent.match(WARNING_PATTERN);

  if (errorMatch) {
    metrics.buildErrors = parseInt(errorMatch[1], 10);
  }
  if (warningMatch) {
    metrics.buildWarnings = parseInt(warningMatch[1], 10);
  }
}

/**
 * Calculate test pass rate percentage.
 */
export function calculateTestPassRate(metrics: JobMetrics): number | undefined {
  if (metrics.testsRun && metrics.testsRun > 0) {
    return Math.round(((metrics.testsPassed || 0) / metrics.testsRun) * 100);
  }
  return undefined;
}

/**
 * Get a human-readable summary of the metrics.
 */
export function getMetricsSummary(metrics: JobMetrics): string {
  const parts: string[] = [];

  if (metrics.testsRun !== undefined) {
    const passRate = calculateTestPassRate(metrics);
    parts.push(`Tests: ${metrics.testsPassed || 0}/${metrics.testsRun} passed${passRate !== undefined ? ` (${passRate}%)` : ''}`);
  }

  if (metrics.coveragePercent !== undefined) {
    parts.push(`Coverage: ${metrics.coveragePercent}%`);
  }

  if (metrics.buildErrors !== undefined && metrics.buildErrors > 0) {
    parts.push(`Errors: ${metrics.buildErrors}`);
  }

  if (metrics.buildWarnings !== undefined && metrics.buildWarnings > 0) {
    parts.push(`Warnings: ${metrics.buildWarnings}`);
  }

  return parts.length > 0 ? parts.join(', ') : 'No metrics available';
}
