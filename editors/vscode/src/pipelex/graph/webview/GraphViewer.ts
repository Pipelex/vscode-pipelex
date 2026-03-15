import type {
    ViewSpec,
    GraphSpec,
    GraphConfig,
    GraphNode,
    GraphEdge,
    DataflowAnalysis,
    LabelDescriptor,
} from './types';
import { buildGraph } from './graphBuilders';
import { getLayoutedElements, ensureControllerSpacing } from './graphLayout';
import { applyControllers } from './graphControllers';

// ReactFlow UMD globals (loaded via CDN <script> tags)
const ReactFlowLib = (typeof ReactFlowRenderer !== 'undefined' && ReactFlowRenderer)
    || (typeof window !== 'undefined' && (window as any).ReactFlow)
    || {};
const {
    ReactFlow: ReactFlowComponent,
    useNodesState,
    useEdgesState,
    Background,
} = ReactFlowLib;

// --- Label rendering: maps plain descriptors to React elements ---

function renderLabel(desc: LabelDescriptor): any {
    if (desc.kind === 'pipe') {
        return React.createElement('div', {
            style: {
                padding: '10px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
                textAlign: 'center',
            },
        },
            React.createElement('span', {
                style: {
                    fontFamily: 'var(--font-mono)',
                    fontSize: '13px',
                    fontWeight: 600,
                    color: 'var(--color-pipe-text)',
                },
            }, desc.label),
        );
    }

    if (desc.kind === 'stuff') {
        return React.createElement('div', {
            style: {
                padding: '8px 24px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '2px',
                textAlign: 'center',
            },
        },
            React.createElement('span', {
                style: {
                    fontFamily: 'var(--font-mono)',
                    fontSize: '12px',
                    fontWeight: 600,
                    color: 'var(--color-stuff-text)',
                },
            }, desc.label),
            desc.concept && React.createElement('span', {
                style: {
                    fontSize: '14px',
                    color: 'var(--color-stuff-text-dim)',
                },
            }, desc.concept),
        );
    }

    // orchestration
    const isSucceeded = desc.status === 'succeeded';
    const isFailed = desc.status === 'failed';
    return React.createElement('div', {
        style: {
            padding: '10px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
        },
    },
        React.createElement('div', {
            style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
            },
        },
            React.createElement('span', {
                style: {
                    fontFamily: 'var(--font-mono)',
                    fontSize: '13px',
                    fontWeight: 600,
                    color: 'var(--color-pipe-text)',
                },
            }, desc.label),
            isSucceeded && React.createElement('span', {
                style: {
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: 'var(--color-success)',
                    flexShrink: 0,
                },
            }),
            isFailed && React.createElement('span', {
                style: {
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: 'var(--color-error)',
                    flexShrink: 0,
                },
            }),
        ),
        React.createElement('div', {
            style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
            },
        },
            React.createElement('span', {
                style: {
                    fontSize: '11px',
                    color: 'var(--color-text-dim)',
                },
            }, desc.typeText),
            desc.badge && React.createElement('span', {
                style: {
                    fontSize: '10px',
                    color: 'var(--color-text-muted)',
                    background: 'var(--color-surface-hover)',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    fontFamily: 'var(--font-mono)',
                },
            }, desc.badge),
        ),
    );
}

/** Convert label descriptors to React elements on all nodes */
function hydrateLabels(nodes: GraphNode[]): GraphNode[] {
    return nodes.map(n => {
        if (!n.data.labelDescriptor) return n;
        return {
            ...n,
            data: {
                ...n.data,
                label: renderLabel(n.data.labelDescriptor),
            },
        };
    });
}

// --- Custom node types ---

function ControllerGroupNode({ data }: { data: any }) {
    return React.createElement('div', {
        className: 'controller-group-node',
    },
        data.label ? React.createElement('div', {
            className: 'controller-group-label',
        }, data.label) : null,
        data.pipeType ? React.createElement('div', {
            className: 'controller-group-type',
        }, data.pipeType) : null,
    );
}

// Stable reference to avoid ReactFlow re-mount warnings
const controllerNodeTypes = { controllerGroup: ControllerGroupNode };

// --- Props ---

export interface GraphViewerProps {
    viewspec: ViewSpec | null;
    graphspec: GraphSpec | null;
    config: GraphConfig;
    direction: string;
    showControllers: boolean;
    onNavigateToPipe: (pipeCode: string) => void;
    onDirectionChange: (dir: string) => void;
    onShowControllersChange: (show: boolean) => void;
    onReactFlowInit: (instance: any) => void;
}

// --- Deep-clone helper ---

function cloneCachedNodes(nodes: GraphNode[]): GraphNode[] {
    return nodes.map(n => ({
        ...n,
        position: { ...n.position },
        data: { ...n.data },
        style: n.style ? { ...n.style } : undefined,
    }));
}

// --- Main component ---

export function GraphViewer(props: GraphViewerProps) {
    const {
        viewspec,
        graphspec,
        config,
        direction,
        showControllers,
        onNavigateToPipe,
        onReactFlowInit,
    } = props;

    const [nodes, setNodes, onNodesChange] = useNodesState([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([]);
    const reactFlowRef = React.useRef<any>(null);
    const prevDirectionRef = React.useRef(direction);
    const initialDataRef = React.useRef<any>(null);
    const layoutCacheRef = React.useRef<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);

    const edgeType = config.edgeType || 'bezier';
    const layoutConfig = { nodesep: config.nodesep, ranksep: config.ranksep };

    // Re-layout when direction changes
    React.useEffect(() => {
        if (prevDirectionRef.current === direction) return;
        prevDirectionRef.current = direction;
        if (!initialDataRef.current) return;

        const relayouted = getLayoutedElements(
            initialDataRef.current.nodes, initialDataRef.current.edges, direction, layoutConfig,
        );
        const spaced = initialDataRef.current._analysis
            ? ensureControllerSpacing(relayouted.nodes, initialDataRef.current._graphspec, initialDataRef.current._analysis, direction)
            : relayouted.nodes;
        layoutCacheRef.current = { nodes: spaced, edges: relayouted.edges };
        const withControllers = applyControllers(
            cloneCachedNodes(spaced), relayouted.edges,
            initialDataRef.current._graphspec, initialDataRef.current._analysis,
            showControllers,
        );
        setNodes(hydrateLabels(withControllers.nodes));
        setEdges(withControllers.edges);
        setTimeout(() => {
            if (reactFlowRef.current) {
                reactFlowRef.current.fitView({ padding: 0.1 });
            }
        }, 50);
    }, [direction]);

    // Rebuild controllers when showControllers changes (reuses cached layout)
    React.useEffect(() => {
        if (!layoutCacheRef.current || !initialDataRef.current) return;
        const cachedNodes = cloneCachedNodes(layoutCacheRef.current.nodes);
        const cachedEdges = layoutCacheRef.current.edges;
        const withControllers = applyControllers(
            cachedNodes, cachedEdges,
            initialDataRef.current._graphspec, initialDataRef.current._analysis,
            showControllers,
        );
        setNodes(hydrateLabels(withControllers.nodes));
        setEdges(withControllers.edges);
    }, [showControllers]);

    // Build + layout when viewspec/graphspec data changes
    React.useEffect(() => {
        if (!viewspec) return;

        const { graphData, analysis } = buildGraph(viewspec, graphspec, edgeType);
        initialDataRef.current = graphData;
        initialDataRef.current._analysis = analysis;
        initialDataRef.current._graphspec = graphspec;

        const needsLayout = graphData.nodes.some(n => !n.position || (n.position.x === 0 && n.position.y === 0));
        const layouted = needsLayout
            ? getLayoutedElements(graphData.nodes, graphData.edges, direction, layoutConfig)
            : graphData;
        const spaced = analysis
            ? ensureControllerSpacing(layouted.nodes, graphspec!, analysis, direction)
            : layouted.nodes;
        layoutCacheRef.current = { nodes: spaced, edges: layouted.edges };
        const withControllers = applyControllers(
            cloneCachedNodes(spaced), layouted.edges, graphspec, analysis, showControllers,
        );

        setNodes(hydrateLabels(withControllers.nodes));
        setEdges(withControllers.edges);

        // Fit view after render, then apply zoom/pan overrides
        setTimeout(() => {
            if (reactFlowRef.current) {
                reactFlowRef.current.fitView({ padding: 0.1 });
                if (config.initialZoom !== undefined && config.initialZoom !== null) {
                    reactFlowRef.current.zoomTo(config.initialZoom);
                }
                if (config.panToTop) {
                    const vp = reactFlowRef.current.getViewport();
                    reactFlowRef.current.setViewport({ x: vp.x, y: 20, zoom: vp.zoom });
                }
            }
        }, 100);
    }, [viewspec, graphspec]);

    // Handle node click
    const onNodeClick = React.useCallback((_event: any, node: GraphNode) => {
        const nodeData = node.data || {};
        if (nodeData.isController) {
            const code = nodeData.pipeCode || nodeData.label;
            if (code) onNavigateToPipe(code);
        }
        if (nodeData.isPipe && nodeData.pipeCode) {
            onNavigateToPipe(nodeData.pipeCode);
        }

        setNodes((nds: GraphNode[]) =>
            nds.map((n: GraphNode) => ({
                ...n,
                selected: n.id === node.id,
            })),
        );
    }, [setNodes, onNavigateToPipe]);

    const onInit = React.useCallback((reactFlowInstance: any) => {
        reactFlowRef.current = reactFlowInstance;
        onReactFlowInit(reactFlowInstance);
    }, [onReactFlowInit]);

    return React.createElement('div', { className: 'react-flow-container' },
        React.createElement(ReactFlowComponent, {
            nodes,
            edges,
            nodeTypes: controllerNodeTypes,
            onNodesChange,
            onEdgesChange,
            onNodeClick,
            onInit,
            fitView: true,
            fitViewOptions: { padding: 0.1 },
            defaultEdgeOptions: { type: edgeType },
            minZoom: 0.1,
            proOptions: { hideAttribution: true },
        },
            Background ? React.createElement(Background, {
                variant: 'dots',
                gap: 20,
                size: 1,
                color: 'var(--color-bg-dots)',
            }) : null,
        ),
    );
}
