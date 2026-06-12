import 'leaflet';

declare module 'leaflet' {
  namespace Control {
    class Draw extends L.Control {
      constructor(options?: DrawConstructorOptions);
    }

    interface DrawConstructorOptions {
      position?: L.ControlPosition;
      draw?: DrawOptions;
      edit?: EditOptions;
    }

    interface DrawOptions {
      polyline?: DrawOptions.PolylineOptions | false;
      polygon?: DrawOptions.PolygonOptions | false;
      rectangle?: DrawOptions.RectangleOptions | false;
      circle?: DrawOptions.CircleOptions | false;
      marker?: DrawOptions.MarkerOptions | false;
      circlemarker?: DrawOptions.CircleMarkerOptions | false;
    }

    namespace DrawOptions {
      interface PolylineOptions {
        allowIntersection?: boolean;
        drawError?: any;
        guidelineDistance?: number;
        maxGuideLineLength?: number;
        shapeOptions?: L.PolylineOptions;
        metric?: boolean;
        feet?: boolean;
        nautic?: boolean;
        showLength?: boolean;
        repeatMode?: boolean;
        zIndexOffset?: number;
      }

      interface PolygonOptions extends PolylineOptions {
        showArea?: boolean;
      }

      interface RectangleOptions {
        shapeOptions?: L.PolylineOptions;
        repeatMode?: boolean;
      }

      interface CircleOptions {
        shapeOptions?: L.PathOptions;
        showRadius?: boolean;
        metric?: boolean;
        feet?: boolean;
        nautic?: boolean;
        repeatMode?: boolean;
      }

      interface MarkerOptions {
        icon?: L.Icon;
        zIndexOffset?: number;
        repeatMode?: boolean;
      }

      interface CircleMarkerOptions {
        stroke?: boolean;
        color?: string;
        weight?: number;
        opacity?: number;
        fill?: boolean;
        fillColor?: string;
        fillOpacity?: number;
        clickable?: boolean;
        zIndexOffset?: number;
        repeatMode?: boolean;
      }
    }

    interface EditOptions {
      featureGroup: L.FeatureGroup;
      edit?: boolean | EditHandlerOptions;
      remove?: boolean;
    }

    interface EditHandlerOptions {
      selectedPathOptions?: L.PathOptions;
    }
  }

  namespace Draw {
    namespace Event {
      const CREATED: string;
      const EDITED: string;
      const DELETED: string;
      const DRAWSTART: string;
      const DRAWSTOP: string;
      const DRAWVERTEX: string;
      const EDITSTART: string;
      const EDITMOVE: string;
      const EDITRESIZE: string;
      const EDITVERTEX: string;
      const EDITSTOP: string;
      const DELETESTART: string;
      const DELETESTOP: string;
    }
  }
}
