import { describe, it, expect } from 'vitest';
import { classifyBedrockError, findServiceAnomalyMonitor } from './aws-checks.js';

describe('classifyBedrockError', () => {
  it('classifies AccessDeniedException with model-access remedy', () => {
    const err = Object.assign(new Error('access denied: not allowed'), {
      name: 'AccessDeniedException',
    });
    const result = classifyBedrockError(err);
    expect(result.code).toBe('AccessDeniedException');
    expect(result.remedy).toMatch(/model-catalog/i);
  });

  it('classifies ValidationException with model-id remedy', () => {
    const err = Object.assign(new Error('The provided model identifier is invalid'), {
      name: 'ValidationException',
    });
    const result = classifyBedrockError(err);
    expect(result.code).toBe('ValidationException');
    expect(result.remedy).toMatch(/region|inference profile/i);
  });

  it('classifies UnrecognizedClientException with credentials remedy', () => {
    const err = Object.assign(new Error('bad creds'), {
      name: 'UnrecognizedClientException',
    });
    const result = classifyBedrockError(err);
    expect(result.code).toBe('UnrecognizedClientException');
    expect(result.remedy).toMatch(/aws configure/i);
  });

  it('classifies ThrottlingException', () => {
    const err = Object.assign(new Error('throttled'), {
      name: 'ThrottlingException',
    });
    const result = classifyBedrockError(err);
    expect(result.code).toBe('ThrottlingException');
    expect(result.remedy).toMatch(/quota|retry/i);
  });

  it('falls back to a generic mapping for unknown errors', () => {
    const err = Object.assign(new Error('something else'), { name: 'WeirdError' });
    const result = classifyBedrockError(err);
    expect(result.code).toBe('WeirdError');
    expect(result.raw).toContain('something else');
  });

  it('handles plain Error without a name', () => {
    const err = new Error('mystery');
    err.name = 'Error';
    const result = classifyBedrockError(err);
    expect(result.code).toBe('Error');
  });
});

describe('findServiceAnomalyMonitor', () => {
  const svc = (arn: string, name: string) => ({
    MonitorArn: arn,
    MonitorName: name,
    MonitorType: 'DIMENSIONAL',
    MonitorDimension: 'SERVICE',
  });

  it('returns the DIMENSIONAL/SERVICE monitor when one exists', async () => {
    const client = {
      send: async () => ({ AnomalyMonitors: [svc('arn:aws:ce::1:anomalymonitor/x', 'Default-Services-Monitor')] }),
    };
    const found = await findServiceAnomalyMonitor(client);
    expect(found).toEqual({ arn: 'arn:aws:ce::1:anomalymonitor/x', name: 'Default-Services-Monitor' });
  });

  it('ignores CUSTOM and non-SERVICE monitors', async () => {
    const client = {
      send: async () => ({
        AnomalyMonitors: [
          { MonitorArn: 'arn:custom', MonitorName: 'custom', MonitorType: 'CUSTOM' },
          { MonitorArn: 'arn:la', MonitorName: 'la', MonitorType: 'DIMENSIONAL', MonitorDimension: 'LINKED_ACCOUNT' },
        ],
      }),
    };
    expect(await findServiceAnomalyMonitor(client)).toBeNull();
  });

  it('returns null when the account has no monitors', async () => {
    const client = { send: async () => ({ AnomalyMonitors: [] }) };
    expect(await findServiceAnomalyMonitor(client)).toBeNull();
  });

  it('follows pagination to find a monitor on a later page', async () => {
    let call = 0;
    const client = {
      send: async () => {
        call += 1;
        if (call === 1) return { AnomalyMonitors: [{ MonitorArn: 'arn:c', MonitorType: 'CUSTOM' }], NextPageToken: 'p2' };
        return { AnomalyMonitors: [svc('arn:page2', 'found-later')] };
      },
    };
    const found = await findServiceAnomalyMonitor(client);
    expect(found?.arn).toBe('arn:page2');
    expect(call).toBe(2);
  });

  it('propagates AWS errors to the caller (caller decides fail-soft)', async () => {
    const client = {
      send: async () => {
        throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      },
    };
    await expect(findServiceAnomalyMonitor(client)).rejects.toThrow('denied');
  });
});
