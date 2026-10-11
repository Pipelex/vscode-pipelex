/**
 * Where a feature reports a use. The statistics service registers itself as the
 * sink when it starts, in the Node host and with statistics on; until then, in a
 * browser host, or in a test, a use is counted nowhere.
 *
 * Dependency-free, so every feature can call it without loading the service.
 */

import type { Feature } from './contract';

type FeatureSink = (feature: Feature) => void;

let sink: FeatureSink | undefined;

export function recordFeatureUse(feature: Feature): void {
    if (!sink) return;
    try {
        sink(feature);
    } catch {
        // Counting a use must never break the feature that reports it.
    }
}

/** Install the service's sink, answering the function that removes it. */
export function setFeatureSink(next: FeatureSink | undefined): () => void {
    sink = next;
    return () => {
        if (sink === next) sink = undefined;
    };
}
