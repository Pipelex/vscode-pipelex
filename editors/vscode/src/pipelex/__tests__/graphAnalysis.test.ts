import { describe, it, expect } from 'vitest';
import { buildDataflowAnalysis, buildChildToControllerMap } from '../graph/webview/graphAnalysis';
import type { GraphSpec } from '../graph/webview/types';

function makeGraphSpec(overrides?: Partial<GraphSpec>): GraphSpec {
    return {
        nodes: [],
        edges: [],
        ...overrides,
    };
}

describe('buildDataflowAnalysis', () => {
    it('returns null for falsy input', () => {
        expect(buildDataflowAnalysis(null as any)).toBeNull();
    });

    it('builds containment tree from "contains" edges', () => {
        const gs = makeGraphSpec({
            nodes: [
                { id: 'ctrl1' },
                { id: 'op1' },
                { id: 'op2' },
            ],
            edges: [
                { source: 'ctrl1', target: 'op1', kind: 'contains' },
                { source: 'ctrl1', target: 'op2', kind: 'contains' },
            ],
        });
        const result = buildDataflowAnalysis(gs)!;
        expect(result.containmentTree['ctrl1']).toEqual(['op1', 'op2']);
        expect(result.controllerNodeIds.has('ctrl1')).toBe(true);
        expect(result.childNodeIds.has('op1')).toBe(true);
        expect(result.childNodeIds.has('op2')).toBe(true);
    });

    it('registers stuff from node IO and tracks producers/consumers', () => {
        const gs = makeGraphSpec({
            nodes: [
                {
                    id: 'producer',
                    io: {
                        outputs: [{ digest: 'd1', name: 'result', concept: 'Text' }],
                    },
                },
                {
                    id: 'consumer',
                    io: {
                        inputs: [{ digest: 'd1', name: 'result', concept: 'Text' }],
                    },
                },
            ],
            edges: [],
        });
        const result = buildDataflowAnalysis(gs)!;
        expect(result.stuffRegistry['d1']).toEqual({
            name: 'result',
            concept: 'Text',
            contentType: undefined,
        });
        expect(result.stuffProducers['d1']).toBe('producer');
        expect(result.stuffConsumers['d1']).toEqual(['consumer']);
    });

    it('excludes controllers from producer/consumer tracking', () => {
        const gs = makeGraphSpec({
            nodes: [
                {
                    id: 'ctrl',
                    io: {
                        outputs: [{ digest: 'd1', name: 'out' }],
                        inputs: [{ digest: 'd2', name: 'in' }],
                    },
                },
                { id: 'child' },
            ],
            edges: [
                { source: 'ctrl', target: 'child', kind: 'contains' },
            ],
        });
        const result = buildDataflowAnalysis(gs)!;
        expect(result.stuffProducers['d1']).toBeUndefined();
        expect(result.stuffConsumers['d2']).toBeUndefined();
        // But stuff should still be registered
        expect(result.stuffRegistry['d1']).toBeDefined();
        expect(result.stuffRegistry['d2']).toBeDefined();
    });
});

describe('buildChildToControllerMap', () => {
    it('maps direct children to their controller', () => {
        const gs = makeGraphSpec({
            nodes: [
                { id: 'ctrl' },
                { id: 'op1' },
            ],
            edges: [
                { source: 'ctrl', target: 'op1', kind: 'contains' },
            ],
        });
        const analysis = buildDataflowAnalysis(gs)!;
        const map = buildChildToControllerMap(gs, analysis);
        expect(map['op1']).toBe('ctrl');
    });

    it('assigns stuff nodes to controller of their producer', () => {
        const gs = makeGraphSpec({
            nodes: [
                { id: 'ctrl' },
                {
                    id: 'op1',
                    io: { outputs: [{ digest: 'd1', name: 'out' }] },
                },
            ],
            edges: [
                { source: 'ctrl', target: 'op1', kind: 'contains' },
            ],
        });
        const analysis = buildDataflowAnalysis(gs)!;
        const map = buildChildToControllerMap(gs, analysis);
        expect(map['stuff_d1']).toBe('ctrl');
    });

    it('assigns controller output stuff to parent controller', () => {
        const gs = makeGraphSpec({
            nodes: [
                { id: 'parent_ctrl' },
                {
                    id: 'child_ctrl',
                    io: { outputs: [{ digest: 'd1', name: 'out' }] },
                },
                { id: 'op1' },
            ],
            edges: [
                { source: 'parent_ctrl', target: 'child_ctrl', kind: 'contains' },
                { source: 'child_ctrl', target: 'op1', kind: 'contains' },
            ],
        });
        const analysis = buildDataflowAnalysis(gs)!;
        const map = buildChildToControllerMap(gs, analysis);
        expect(map['stuff_d1']).toBe('parent_ctrl');
    });

    it('assigns batch item stuff to PipeBatch controller', () => {
        const gs = makeGraphSpec({
            nodes: [
                { id: 'batch_ctrl' },
                { id: 'op1' },
            ],
            edges: [
                { source: 'batch_ctrl', target: 'op1', kind: 'contains' },
                {
                    source: 'batch_ctrl',
                    target: 'op1',
                    kind: 'batch_item',
                    target_stuff_digest: 'd1',
                },
            ],
        });
        const analysis = buildDataflowAnalysis(gs)!;
        const map = buildChildToControllerMap(gs, analysis);
        expect(map['stuff_d1']).toBe('batch_ctrl');
    });
});
