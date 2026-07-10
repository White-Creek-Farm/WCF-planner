import {describe, expect, it, vi} from 'vitest';
import {detachCattleFromProcessingBatch, detachSheepFromProcessingBatch} from './processingDetachApi.js';

describe('processingDetachApi', () => {
  it('maps cattle arguments to the stable migration-081 RPC signature', async () => {
    const result = {ok: true, reason: 'detached', prior_herd: 'finishers'};
    const sb = {rpc: vi.fn().mockResolvedValue({data: result, error: null})};

    await expect(
      detachCattleFromProcessingBatch(sb, {
        cattleId: 'cow-1',
        batchId: 'batch-1',
        teamMember: 'Client display name',
      }),
    ).resolves.toBe(result);
    expect(sb.rpc).toHaveBeenCalledWith('detach_cattle_from_processing_batch', {
      p_cattle_id: 'cow-1',
      p_batch_id: 'batch-1',
      p_team_member: 'Client display name',
    });
  });

  it('maps sheep arguments to the stable migration-081 RPC signature', async () => {
    const result = {ok: true, reason: 'detached', prior_flock: 'feeders'};
    const sb = {rpc: vi.fn().mockResolvedValue({data: result, error: null})};

    await expect(
      detachSheepFromProcessingBatch(sb, {
        sheepId: 'sheep-1',
        batchId: 'batch-2',
        teamMember: 'Client display name',
      }),
    ).resolves.toBe(result);
    expect(sb.rpc).toHaveBeenCalledWith('detach_sheep_from_processing_batch', {
      p_sheep_id: 'sheep-1',
      p_batch_id: 'batch-2',
      p_team_member: 'Client display name',
    });
  });

  it.each([
    ['cattle', detachCattleFromProcessingBatch],
    ['sheep', detachSheepFromProcessingBatch],
  ])('%s wrapper preserves non-throwing transport errors for UI warnings', async (_label, detach) => {
    const sb = {rpc: vi.fn().mockResolvedValue({data: null, error: {message: 'not permitted'}})};
    await expect(detach(sb, {})).resolves.toEqual({ok: false, reason: 'rpc_error', error: 'not permitted'});
  });

  it.each([
    ['cattle', detachCattleFromProcessingBatch],
    ['sheep', detachSheepFromProcessingBatch],
  ])('%s wrapper fails closed when PostgREST returns no result', async (_label, detach) => {
    const sb = {rpc: vi.fn().mockResolvedValue({data: null, error: null})};
    await expect(detach(sb, {})).resolves.toEqual({ok: false, reason: 'no_result'});
  });
});
