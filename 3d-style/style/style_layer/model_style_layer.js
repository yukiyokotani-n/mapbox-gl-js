// @flow

import StyleLayer from '../../../src/style/style_layer.js';
import ModelBucket from '../../data/bucket/model_bucket.js';
import properties from './model_style_layer_properties.js';
import {Transitionable, Transitioning, PossiblyEvaluated, PropertyValue} from '../../../src/style/properties.js';
import Point from '@mapbox/point-geometry';
import {ZoomDependentExpression} from '../../../src/style-spec/expression/index.js';
import {mat4} from 'gl-matrix';

import type {LayerSpecification} from '../../../src/style-spec/types.js';
import type {PaintProps, LayoutProps} from './model_style_layer_properties.js';
import type {BucketParameters} from '../../../src/data/bucket.js';
import type {ConfigOptions} from '../../../src/style/properties.js';
import type {TilespaceQueryGeometry} from '../../../src/style/query_geometry.js';
import type {FeatureState} from '../../../src/style-spec/expression/index.js';
import type Transform from '../../../src/geo/transform.js';
import ModelManager from '../../render/model_manager.js';
import {calculateModelMatrix} from '../../data/model.js';
import LngLat from '../../../src/geo/lng_lat.js';
import type {Mat4} from 'gl-matrix';

import {latFromMercatorY, lngFromMercatorX} from '../../../src/geo/mercator_coordinate.js';
import EXTENT from '../../../src/style-spec/data/extent.js';
import {convertModelMatrixForGlobe, queryGeometryIntersectsProjectedAabb} from '../../util/model_util.js';
import Map from '../../../src/ui/map.js';
import type {IVectorTileFeature} from '@mapbox/vector-tile';

class ModelStyleLayer extends StyleLayer {
    _transitionablePaint: Transitionable<PaintProps>;
    _transitioningPaint: Transitioning<PaintProps>;
    paint: PossiblyEvaluated<PaintProps>;
    layout: PossiblyEvaluated<LayoutProps>;
    modelManager: ModelManager;

    constructor(layer: LayerSpecification, scope: string, options?: ?ConfigOptions) {
        super(layer, properties, scope, options);
    }

    createBucket(parameters: BucketParameters<ModelStyleLayer>): ModelBucket {
        return new ModelBucket(parameters);
    }

    getProgramIds(): Array<string> {
        return ['model'];
    }

    is3D(): boolean {
        return true;
    }

    hasShadowPass(): boolean {
        return true;
    }

    canCastShadows(): boolean {
        return true;
    }

    hasLightBeamPass(): boolean {
        return true;
    }

    cutoffRange(): number {
        return this.paint.get('model-cutoff-fade-range');
    }

    // $FlowFixMe[method-unbinding]
    queryRadius(): number {
        return 0;
    }

    onRemove: ?(map: Map) => void;

    // $FlowFixMe[method-unbinding]
    queryIntersectsFeature(queryGeometry: TilespaceQueryGeometry,
        feature: IVectorTileFeature,
        featureState: FeatureState,
        geometry: Array<Array<Point>>,
        zoom: number,
        transform: Transform): number | boolean {
        if (!this.modelManager) return false;
        const modelManager = this.modelManager;
        const b = queryGeometry.tile.getBucket(this);
        if (!b || !(b instanceof ModelBucket)) return false;
        const bucket: ModelBucket = (b: any);

        for (const modelId in bucket.instancesPerModel) {
            const instances = bucket.instancesPerModel[modelId];
            if (instances.idToFeaturesIndex.hasOwnProperty(feature.id)) {
                const modelFeature = instances.features[instances.idToFeaturesIndex[feature.id]];
                const model = modelManager.getModel(modelId, this.scope);
                if (!model) return false;

                let matrix: Mat4 = mat4.create();
                const position = new LngLat(0, 0);
                const id = bucket.canonical;
                let minDepth = Number.MAX_VALUE;
                for (let i = 0; i < modelFeature.instancedDataCount; ++i) {
                    const instanceOffset = modelFeature.instancedDataOffset + i;
                    const offset = instanceOffset * 16;

                    const va = instances.instancedDataArray.float32;
                    const translation = [va[offset + 4], va[offset + 5], va[offset + 6]];
                    const pointX = va[offset];
                    const pointY = va[offset + 1] | 0; // point.y stored in integer part

                    const tileCount = 1 << id.z;
                    position.lat = latFromMercatorY((pointY / EXTENT + id.y) / tileCount);
                    position.lng = lngFromMercatorX((pointX / EXTENT + id.x) / tileCount);

                    calculateModelMatrix(matrix,
                                         model,
                                         transform,
                                         position,
                                         modelFeature.rotation,
                                         modelFeature.scale,
                                         translation,
                                         false,
                                         false,
                                         false);
                    if (transform.projection.name === 'globe') {
                        matrix = convertModelMatrixForGlobe(matrix, transform);
                    }
                    const worldViewProjection = mat4.multiply([], transform.projMatrix, matrix);
                    // Collision checks are performed in screen space. Corners are in ndc space.
                    const screenQuery = queryGeometry.queryGeometry;
                    const projectedQueryGeometry = screenQuery.isPointQuery() ? screenQuery.screenBounds : screenQuery.screenGeometry;
                    const depth = queryGeometryIntersectsProjectedAabb(projectedQueryGeometry, transform, worldViewProjection, model.aabb);
                    if (depth != null) {
                        minDepth = Math.min(depth, minDepth);
                    }
                }
                if (minDepth !== Number.MAX_VALUE) {
                    return minDepth;
                }
                return false;
            }
        }
        return false;
    }

    _handleOverridablePaintPropertyUpdate<T, R>(name: string, oldValue: PropertyValue<T, R>, newValue: PropertyValue<T, R>): boolean {
        if (!this.layout || oldValue.isDataDriven() || newValue.isDataDriven()) {
            return false;
        }
        // relayout on programatically setPaintProperty for all non-data-driven properties that get baked into vertex data.
        // Buckets could be updated without relayout later, if needed to optimize.
        return name === "model-color" || name === "model-color-mix-intensity" || name === "model-rotation" || name === "model-scale" || name === "model-translation" || name === "model-emissive-strength";
    }

    _isPropertyZoomDependent(name: string): boolean {
        const prop = this._transitionablePaint._values[name];
        return prop != null && prop.value != null &&
            prop.value.expression != null &&
            prop.value.expression instanceof ZoomDependentExpression;
    }

    isZoomDependent(): boolean {
        return this._isPropertyZoomDependent('model-scale') ||
            this._isPropertyZoomDependent('model-rotation') ||
            this._isPropertyZoomDependent('model-translation');
    }
}

export default ModelStyleLayer;
