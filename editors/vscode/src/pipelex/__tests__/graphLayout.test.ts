import { describe, it, expect } from 'vitest';
import { ensureControllerSpacing } from '../graph/webview/graphLayout';
import { buildDataflowAnalysis } from '../graph/webview/graphAnalysis';
import type { GraphSpec, GraphNode } from '../graph/webview/types';

function makePipeNode(id: string, x: number, y: number, width = 200): GraphNode {
    return {
        id,
        type: 'default',
        data: {
            isPipe: true,
            isStuff: false,
            labelText: id,
        },
        position: { x, y },
        style: { width: width + 'px' },
    };
}

function makeStuffNode(id: string, x: number, y: number, width = 140): GraphNode {
    return {
        id,
        type: 'default',
        data: {
            isPipe: false,
            isStuff: true,
            labelText: 'data',
        },
        position: { x, y },
        style: { width: width + 'px' },
    };
}

describe('ensureControllerSpacing', () => {
    it('returns nodes unchanged when analysis is null', () => {
        const nodes = [makePipeNode('op1', 0, 0)];
        const result = ensureControllerSpacing(nodes, { nodes: [], edges: [] }, null as any, 'TB');
        expect(result).toEqual(nodes);
    });

    it('returns nodes unchanged when graphspec is null', () => {
        const nodes = [makePipeNode('op1', 0, 0)];
        const result = ensureControllerSpacing(nodes, null as any, {} as any, 'TB');
        expect(result).toEqual(nodes);
    });

    it('Phase 1: pushes overlapping sibling controllers apart', () => {
        // Two sibling controllers, each with one child node, placed overlapping
        const gs: GraphSpec = {
            nodes: [
                { id: 'root' },
                { id: 'ctrl_a' },
                { id: 'ctrl_b' },
                { id: 'op_a' },
                { id: 'op_b' },
            ],
            edges: [
                { source: 'root', target: 'ctrl_a', kind: 'contains' },
                { source: 'root', target: 'ctrl_b', kind: 'contains' },
                { source: 'ctrl_a', target: 'op_a', kind: 'contains' },
                { source: 'ctrl_b', target: 'op_b', kind: 'contains' },
            ],
        };
        const analysis = buildDataflowAnalysis(gs)!;

        // Place both children at the same position (guaranteed overlap)
        const nodes = [
            makePipeNode('op_a', 100, 100),
            makePipeNode('op_b', 100, 100),
        ];

        const result = ensureControllerSpacing(nodes, gs, analysis, 'TB');

        // After spacing, the two nodes should no longer overlap
        const nodeA = result.find(n => n.id === 'op_a')!;
        const nodeB = result.find(n => n.id === 'op_b')!;
        // They should be separated by at least some gap
        const separation = Math.abs(nodeA.position.x - nodeB.position.x)
            + Math.abs(nodeA.position.y - nodeB.position.y);
        expect(separation).toBeGreaterThan(0);
    });

    it('Phase 4: aligns leaf controller children on order axis (TB)', () => {
        // A leaf controller with two children at different X positions
        const gs: GraphSpec = {
            nodes: [
                { id: 'root' },
                { id: 'ctrl', pipe_type: 'PipeSequence' },
                { id: 'op1' },
                { id: 'op2' },
            ],
            edges: [
                { source: 'root', target: 'ctrl', kind: 'contains' },
                { source: 'ctrl', target: 'op1', kind: 'contains' },
                { source: 'ctrl', target: 'op2', kind: 'contains' },
            ],
        };
        const analysis = buildDataflowAnalysis(gs)!;
        const nodes = [
            makePipeNode('op1', 50, 100),
            makePipeNode('op2', 150, 200),
        ];

        const result = ensureControllerSpacing(nodes, gs, analysis, 'TB');

        // In TB mode, Phase 4 aligns on X axis — both should have same X center
        const op1 = result.find(n => n.id === 'op1')!;
        const op2 = result.find(n => n.id === 'op2')!;
        const w = 200; // default width
        const center1 = op1.position.x + w / 2;
        const center2 = op2.position.x + w / 2;
        expect(center1).toBe(center2);
    });

    it('Phase 4: skips PipeParallel controllers', () => {
        const gs: GraphSpec = {
            nodes: [
                { id: 'root' },
                { id: 'ctrl', pipe_type: 'PipeParallel' },
                { id: 'op1' },
                { id: 'op2' },
            ],
            edges: [
                { source: 'root', target: 'ctrl', kind: 'contains' },
                { source: 'ctrl', target: 'op1', kind: 'contains' },
                { source: 'ctrl', target: 'op2', kind: 'contains' },
            ],
        };
        const analysis = buildDataflowAnalysis(gs)!;
        const nodes = [
            makePipeNode('op1', 50, 100),
            makePipeNode('op2', 300, 200),
        ];

        const result = ensureControllerSpacing(nodes, gs, analysis, 'TB');

        // PipeParallel should NOT align children — X positions stay different
        const op1 = result.find(n => n.id === 'op1')!;
        const op2 = result.find(n => n.id === 'op2')!;
        expect(op1.position.x).not.toBe(op2.position.x);
    });

    it('does not mutate input nodes', () => {
        const gs: GraphSpec = {
            nodes: [
                { id: 'root' },
                { id: 'ctrl', pipe_type: 'PipeSequence' },
                { id: 'op1' },
            ],
            edges: [
                { source: 'root', target: 'ctrl', kind: 'contains' },
                { source: 'ctrl', target: 'op1', kind: 'contains' },
            ],
        };
        const analysis = buildDataflowAnalysis(gs)!;
        const original = makePipeNode('op1', 50, 100);
        const nodes = [original];
        const originalX = original.position.x;

        ensureControllerSpacing(nodes, gs, analysis, 'TB');

        // Original node position should not be mutated
        expect(original.position.x).toBe(originalX);
    });
});
