import { describe, it, expect } from 'vitest';
import { buildControllerNodes, applyControllers } from '../graph/webview/graphControllers';
import { buildDataflowAnalysis } from '../graph/webview/graphAnalysis';
import type { GraphSpec, GraphNode } from '../graph/webview/types';

function makePipeNode(id: string, x: number, y: number, pipeCode?: string): GraphNode {
    return {
        id,
        type: 'default',
        data: {
            isPipe: true,
            isStuff: false,
            labelText: pipeCode || id,
            pipeCode: pipeCode || id,
        },
        position: { x, y },
        style: { width: '200px' },
    };
}

function makeStuffNode(id: string, x: number, y: number): GraphNode {
    return {
        id,
        type: 'default',
        data: {
            isPipe: false,
            isStuff: true,
            labelText: 'data',
        },
        position: { x, y },
        style: { width: '140px' },
    };
}

describe('buildControllerNodes', () => {
    it('creates controller group nodes wrapping children', () => {
        const gs: GraphSpec = {
            nodes: [
                { id: 'root', pipe_code: 'main' },
                { id: 'ctrl1', pipe_code: 'sub_pipe', pipe_type: 'PipeSequence' },
                { id: 'op1', pipe_code: 'step1' },
                { id: 'op2', pipe_code: 'step2' },
            ],
            edges: [
                { source: 'root', target: 'ctrl1', kind: 'contains' },
                { source: 'ctrl1', target: 'op1', kind: 'contains' },
                { source: 'ctrl1', target: 'op2', kind: 'contains' },
            ],
        };
        const analysis = buildDataflowAnalysis(gs)!;
        const layoutedNodes = [
            makePipeNode('op1', 100, 100),
            makePipeNode('op2', 100, 200),
        ];

        const controllerNodes = buildControllerNodes(gs, analysis, layoutedNodes);

        expect(controllerNodes).toHaveLength(1);
        expect(controllerNodes[0].id).toBe('ctrl1');
        expect(controllerNodes[0].type).toBe('controllerGroup');
        expect(controllerNodes[0].data.isController).toBe(true);
        expect(controllerNodes[0].data.pipeType).toBe('PipeSequence');
    });

    it('converts child positions to parent-relative', () => {
        const gs: GraphSpec = {
            nodes: [
                { id: 'root' },
                { id: 'ctrl1', pipe_code: 'sub' },
                { id: 'op1' },
            ],
            edges: [
                { source: 'root', target: 'ctrl1', kind: 'contains' },
                { source: 'ctrl1', target: 'op1', kind: 'contains' },
            ],
        };
        const analysis = buildDataflowAnalysis(gs)!;
        const layoutedNodes = [makePipeNode('op1', 100, 200)];

        buildControllerNodes(gs, analysis, layoutedNodes);

        // After building controllers, op1 should have parentNode set
        expect(layoutedNodes[0].parentNode).toBe('ctrl1');
        expect(layoutedNodes[0].extent).toBe('parent');
        // Position should now be relative to the controller
        // Controller position.x = 100 - 40 (padding) = 60
        // So child relative x = 100 - 60 = 40
        expect(layoutedNodes[0].position.x).toBe(40);
    });

    it('handles implicit PipeBatch naming', () => {
        const gs: GraphSpec = {
            nodes: [
                { id: 'root' },
                { id: 'ctrl1', pipe_code: 'my_pipe_batch', pipe_type: 'PipeBatch' },
                { id: 'op1' },
            ],
            edges: [
                { source: 'root', target: 'ctrl1', kind: 'contains' },
                { source: 'ctrl1', target: 'op1', kind: 'contains' },
            ],
        };
        const analysis = buildDataflowAnalysis(gs)!;
        const layoutedNodes = [makePipeNode('op1', 0, 0)];

        const controllerNodes = buildControllerNodes(gs, analysis, layoutedNodes);

        expect(controllerNodes[0].data.label).toBeNull();
        expect(controllerNodes[0].data.pipeType).toBe('implicit PipeBatch');
        expect(controllerNodes[0].data.pipeCode).toBe('my_pipe');
    });

    it('skips root controller (no parent)', () => {
        const gs: GraphSpec = {
            nodes: [
                { id: 'root', pipe_code: 'main' },
                { id: 'op1' },
            ],
            edges: [
                { source: 'root', target: 'op1', kind: 'contains' },
            ],
        };
        const analysis = buildDataflowAnalysis(gs)!;
        const layoutedNodes = [makePipeNode('op1', 0, 0)];

        const controllerNodes = buildControllerNodes(gs, analysis, layoutedNodes);

        // Root controller has no parent, so it should be skipped
        expect(controllerNodes).toHaveLength(0);
    });
});

describe('applyControllers', () => {
    it('returns nodes unchanged when showControllers is false', () => {
        const nodes = [makePipeNode('op1', 0, 0)];
        const edges: any[] = [];
        const result = applyControllers(nodes, edges, null, null, false);
        expect(result.nodes).toBe(nodes);
    });

    it('returns nodes unchanged when analysis is null', () => {
        const nodes = [makePipeNode('op1', 0, 0)];
        const edges: any[] = [];
        const result = applyControllers(nodes, edges, { nodes: [], edges: [] }, null, true);
        expect(result.nodes).toBe(nodes);
    });

    it('sorts parent nodes before children when controllers applied', () => {
        const gs: GraphSpec = {
            nodes: [
                { id: 'root' },
                { id: 'ctrl1', pipe_code: 'sub' },
                { id: 'op1' },
            ],
            edges: [
                { source: 'root', target: 'ctrl1', kind: 'contains' },
                { source: 'ctrl1', target: 'op1', kind: 'contains' },
            ],
        };
        const analysis = buildDataflowAnalysis(gs)!;
        const nodes = [makePipeNode('op1', 100, 100)];
        const edges: any[] = [];

        const result = applyControllers(nodes, edges, gs, analysis, true);

        // Controller should appear before its child
        const ctrlIdx = result.nodes.findIndex(n => n.id === 'ctrl1');
        const opIdx = result.nodes.findIndex(n => n.id === 'op1');
        expect(ctrlIdx).toBeLessThan(opIdx);
    });
});
