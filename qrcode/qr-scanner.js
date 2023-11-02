declare namespace QrScanner {
  export interface ScanRegion {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    downScaledWidth?: number;
    downScaledHeight?: number;
  }

  export interface Point {
    x: number;
    y: number;
  }

  export interface ScanResult {
    data: string;
  }
}

declare class BarcodeDetector {
  constructor(options?: { formats: string[] });

  static getSupportedFormats(): Promise<string[]>;

  detect(image: ImageBitmapSource): Promise<Array<{ rawValue: string, cornerPoints: QrScanner.Point[] }>>;
}

declare global {
  interface Navigator {
    readonly userAgentData?: {
      readonly platform: string;
      readonly brands: Array<{
        readonly brand: string;
        readonly version: string;
      }>;
      getHighEntropyValues(hints: string[]): Promise<{
        readonly architecture?: string;
        readonly platformVersion?: string;
      }>;
    };
  }
}

export class QrScanner {
  static readonly NO_QR_CODE_FOUND = 'No QR code found';
  private static _disableBarcodeDetector = false;
  private static _workerMessageId = 0;

  static async scanImage(
    imageOrFileOrBlobOrUrl: HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap
      | SVGImageElement | File | Blob | URL | String,
    options: {
      scanRegion?: QrScanner.ScanRegion | null,
      qrEngine?: Worker | BarcodeDetector | Promise<Worker | BarcodeDetector> | null,
      canvas?: HTMLCanvasElement | null,
      disallowCanvasResizing?: boolean,
      alsoTryWithoutScanRegion?: boolean,
      timeout?: number,
    }
  ): Promise<QrScanner.ScanResult> {
    let scanRegion: QrScanner.ScanRegion | null | undefined = options.scanRegion;
    let qrEngine = options.qrEngine;
    let canvas = options.canvas;
    let disallowCanvasResizing = options.disallowCanvasResizing || false;
    let alsoTryWithoutScanRegion = options.alsoTryWithoutScanRegion || false;
    const gotExternalEngine = !!qrEngine;

    try {
      let image: HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap
        | SVGImageElement;
      let canvasContext: CanvasRenderingContext2D;
      [qrEngine, image] = await Promise.all([
        qrEngine || QrScanner.createQrEngine(),
        QrScanner._loadImage(imageOrFileOrBlobOrUrl),
      ]);
      [canvas, canvasContext] = QrScanner._drawToCanvas(image, scanRegion, canvas, disallowCanvasResizing);
      let detailedScanResult: QrScanner.ScanResult;

      if (qrEngine instanceof Worker) {
        const qrEngineWorker = qrEngine;
        if (!gotExternalEngine) {
          // Enable scanning of inverted color qr codes.
          QrScanner._postWorkerMessageSync(qrEngineWorker, 'inversionMode', 'both');
        }
        let timeout: any;
        detailedScanResult = await new Promise((resolve, reject) => {
          let onMessage: (event: MessageEvent) => void;
          let onError: (error: ErrorEvent | string) => void;
          let expectedResponseId = -1;
          onMessage = (event: MessageEvent) => {
            if (event.data.id !== expectedResponseId) {
              return;
            }
            qrEngineWorker.removeEventListener('message', onMessage);
            qrEngineWorker.removeEventListener('error', onError);
            clearTimeout(timeout);
            if (event.data.data !== null) {
              resolve({
                data: event.data.data
              });
            } else {
              reject(QrScanner.NO_QR_CODE_FOUND);
            }
          };
          onError = (error: ErrorEvent | string) => {
            qrEngineWorker.removeEventListener('message', onMessage);
            qrEngineWorker.removeEventListener('error', onError);
            clearTimeout(timeout);
            const errorMessage = !error ? 'Unknown Error' : ((error as ErrorEvent).message || error);
            reject('Scanner error: ' + errorMessage);
          };
          qrEngineWorker.addEventListener('message', onMessage);
          qrEngineWorker.addEventListener('error', onError);
          timeout = setTimeout(() => onError('timeout'), options['timeout'] || 10000);
          const imageData = canvasContext.getImageData(0, 0, canvas!.width, canvas!.height);
          expectedResponseId = QrScanner._postWorkerMessageSync(
            qrEngineWorker,
            'decode',
            imageData,
            [imageData.data.buffer],
          );
        });
      } else {
        detailedScanResult = await Promise.race([
          new Promise<QrScanner.ScanResult>((resolve, reject) => window.setTimeout(
            () => reject('Scanner error: timeout'),
            options['timeout'] || 10000,
          )), (async (): Promise<QrScanner.ScanResult> => {
            try {
              const [scanResult] = await qrEngine.detect(canvas!);
              return {
                data: scanResult ? scanResult.rawValue : QrScanner.NO_QR_CODE_FOUND
              };
            } catch (e) {
              const errorMessage = (e as Error).message || e as string;
              if (/not implemented|service unavailable/.test(errorMessage)) {
                QrScanner._disableBarcodeDetector = true;
                // retry without passing the broken BarcodeScanner instance
                return QrScanner.scanImage(imageOrFileOrBlobOrUrl, {
                  scanRegion,
                  canvas,
                  disallowCanvasResizing,
                  alsoTryWithoutScanRegion,
                });
              }
              throw `Scanner error: ${errorMessage}`;
            }
          })(),
        ]);
      }
      return detailedScanResult;
    } catch (e) {
      if (!scanRegion || !alsoTryWithoutScanRegion) throw e;
      return await QrScanner.scanImage(
        imageOrFileOrBlobOrUrl,
        {qrEngine, canvas, disallowCanvasResizing},
      );
    } finally {
      if (!gotExternalEngine) {
        QrScanner._postWorkerMessage(qrEngine!, 'close');
      }
    }
  }

  static async createQrEngine(): Promise<Worker | BarcodeDetector> {
    // @ts-ignore no types defined for import
    const createWorker = () => (import('src/assets/js/qr-scanner-worker.min.js') as Promise<{ createWorker: () => Worker }>)
      .then((module) => module.createWorker());

    const useBarcodeDetector = !QrScanner._disableBarcodeDetector
      && 'BarcodeDetector' in window
      && BarcodeDetector.getSupportedFormats
      && (await BarcodeDetector.getSupportedFormats()).includes('qr_code');

    if (!useBarcodeDetector) return createWorker();

    const userAgentData = navigator.userAgentData;
    const isChromiumOnMacWithArmVentura = userAgentData // all Chromium browsers support userAgentData
      && userAgentData.brands.some(({brand}) => /Chromium/i.test(brand))
      && /mac ?OS/i.test(userAgentData.platform)
      && await userAgentData.getHighEntropyValues(['architecture', 'platformVersion'])
        .then(({architecture, platformVersion}) =>
          /arm/i.test(architecture || 'arm') && parseInt(platformVersion || '13') >= /* Ventura */ 13)
        .catch(() => true);
    if (isChromiumOnMacWithArmVentura) return createWorker();

    return new BarcodeDetector({formats: ['qr_code']});
  }

  private static _drawToCanvas(
    image: HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap
      | SVGImageElement,
    scanRegion?: QrScanner.ScanRegion | null,
    canvas?: HTMLCanvasElement | null,
    disallowCanvasResizing = false,
  ): [HTMLCanvasElement, CanvasRenderingContext2D] {
    canvas = canvas || document.createElement('canvas');
    const scanRegionX = scanRegion && scanRegion.x ? scanRegion.x : 0;
    const scanRegionY = scanRegion && scanRegion.y ? scanRegion.y : 0;
    const scanRegionWidth = scanRegion && scanRegion.width ? scanRegion.width : image.width as number;
    const scanRegionHeight = scanRegion && scanRegion.height ? scanRegion.height : image.height as number;

    if (!disallowCanvasResizing) {
      const canvasWidth = scanRegion && scanRegion.downScaledWidth
        ? scanRegion.downScaledWidth
        : scanRegionWidth;
      const canvasHeight = scanRegion && scanRegion.downScaledHeight
        ? scanRegion.downScaledHeight
        : scanRegionHeight;
      // Setting the canvas width or height clears the canvas, even if the values didn't change, therefore only
      // set them if they actually changed.
      if (canvas.width !== canvasWidth) {
        canvas.width = canvasWidth;
      }
      if (canvas.height !== canvasHeight) {
        canvas.height = canvasHeight;
      }
    }

    const context = canvas.getContext('2d', {alpha: false})!;
    context.imageSmoothingEnabled = false; // gives less blurry images
    context.drawImage(image, scanRegionX, scanRegionY, scanRegionWidth, scanRegionHeight, 0, 0, canvas.width, canvas.height);
    return [canvas, context];
  }

  private static async _loadImage(
    imageOrFileOrBlobOrUrl: HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap
      | SVGImageElement | File | Blob | URL | String,
  ): Promise<HTMLImageElement  | HTMLCanvasElement | OffscreenCanvas | ImageBitmap
    | SVGImageElement> {
    if (imageOrFileOrBlobOrUrl instanceof Image) {
      await QrScanner._awaitImageLoad(imageOrFileOrBlobOrUrl);
      return imageOrFileOrBlobOrUrl;
    } else if (imageOrFileOrBlobOrUrl instanceof HTMLCanvasElement
      || imageOrFileOrBlobOrUrl instanceof SVGImageElement
      || 'OffscreenCanvas' in window && imageOrFileOrBlobOrUrl instanceof OffscreenCanvas
      || 'ImageBitmap' in window && imageOrFileOrBlobOrUrl instanceof ImageBitmap) {
      return imageOrFileOrBlobOrUrl;
    } else if (imageOrFileOrBlobOrUrl instanceof File || imageOrFileOrBlobOrUrl instanceof Blob
      || imageOrFileOrBlobOrUrl instanceof URL || typeof imageOrFileOrBlobOrUrl === 'string') {
      const image = new Image();
      if (imageOrFileOrBlobOrUrl instanceof File || imageOrFileOrBlobOrUrl instanceof Blob) {
        image.src = URL.createObjectURL(imageOrFileOrBlobOrUrl);
      } else {
        image.src = imageOrFileOrBlobOrUrl.toString();
      }
      try {
        await QrScanner._awaitImageLoad(image);
        return image;
      } finally {
        if (imageOrFileOrBlobOrUrl instanceof File || imageOrFileOrBlobOrUrl instanceof Blob) {
          URL.revokeObjectURL(image.src);
        }
      }
    } else {
      throw 'Unsupported image type.';
    }
  }

  private static async _awaitImageLoad(image: HTMLImageElement): Promise<void> {
    if (image.complete && image.naturalWidth !== 0) return; // already loaded
    await new Promise<void>((resolve, reject) => {
      const listener = (event: ErrorEvent | Event) => {
        image.removeEventListener('load', listener);
        image.removeEventListener('error', listener);
        if (event instanceof ErrorEvent) {
          reject('Image load error');
        } else {
          resolve();
        }
      };
      image.addEventListener('load', listener);
      image.addEventListener('error', listener);
    });
  }

  private static async _postWorkerMessage(
    qrEngineOrQrEnginePromise: Worker | BarcodeDetector | Promise<Worker | BarcodeDetector>,
    type: string,
    data?: any,
    transfer?: Transferable[],
  ): Promise<number> {
    return QrScanner._postWorkerMessageSync(await qrEngineOrQrEnginePromise, type, data, transfer);
  }

  // sync version of _postWorkerMessage without performance overhead of async functions
  private static _postWorkerMessageSync(
    qrEngine: Worker | BarcodeDetector,
    type: string,
    data?: any,
    transfer?: Transferable[],
  ): number {
    if (!(qrEngine instanceof Worker)) return -1;
    const id = QrScanner._workerMessageId++;
    qrEngine.postMessage({id, type, data,}, transfer);
    return id;
  }
}
