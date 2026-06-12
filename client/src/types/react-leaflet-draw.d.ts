declare module 'react-leaflet-draw' {
  import { FC } from 'react';
  import { ControlPosition } from 'leaflet';

  interface EditControlProps {
    position?: ControlPosition;
    onCreated?: (e: any) => void;
    onEdited?: (e: any) => void;
    onDeleted?: (e: any) => void;
    onDrawStart?: (e: any) => void;
    onDrawStop?: (e: any) => void;
    draw?: {
      polyline?: boolean | object;
      polygon?: boolean | object;
      rectangle?: boolean | object;
      circle?: boolean | object;
      circlemarker?: boolean | object;
      marker?: boolean | object;
    };
    edit?: {
      edit?: boolean;
      remove?: boolean;
    };
  }

  export const EditControl: FC<EditControlProps>;
}
