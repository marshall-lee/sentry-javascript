/* eslint-disable max-lines */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Measurements, SpanContext } from '@sentry/types';
import { getGlobalObject, logger } from '@sentry/utils';

import { Span } from '../span';
import { Transaction } from '../transaction';
import { msToSec } from '../utils';

// https://wicg.github.io/event-timing/#sec-performance-event-timing
interface PerformanceEventTiming extends PerformanceEntry {
  processingStart: DOMHighResTimeStamp;
  cancelable?: boolean;
  target?: Element;
}

const global = getGlobalObject<Window>();

/** Class tracking metrics  */
export class MetricsInstrumentation {
  private _firstHiddenTime: number = 0;
  private _lcpFinal: boolean = false;

  private _measurements: Measurements = {};

  private _performanceCursor: number = 0;

  public constructor() {
    if (global && global.performance) {
      if (global.performance.mark) {
        global.performance.mark('sentry-tracing-init');
      }

      // Keep track of whether (and when) the page was first hidden, see:
      // https://github.com/w3c/page-visibility/issues/29
      // NOTE: ideally this check would be performed in the document <head>
      // to avoid cases where the visibility state changes before this code runs.
      this._firstHiddenTime = document.visibilityState === 'hidden' ? 0 : Infinity;

      document.addEventListener(
        'visibilitychange',
        event => {
          this._firstHiddenTime = Math.min(this._firstHiddenTime, event.timeStamp);
        },
        { capture: true, once: true },
      );

      this._trackLCP();
      this._trackFID();
    }
  }

  /** Add performance related spans to a transaction */
  public addPerformanceEntries(transaction: Transaction): void {
    if (!global || !global.performance || !global.performance.getEntries) {
      // Gatekeeper if performance API not available
      return;
    }

    logger.log('[Tracing] Adding & adjusting spans using Performance API');

    // TODO(fixme): depending on the 'op' directly is brittle.
    if (transaction.op === 'pageload') {
      // Force any pending records to be dispatched.
      this._forceLCP();
    }

    const timeOrigin = msToSec(performance.timeOrigin);
    let entryScriptSrc: string | undefined;

    if (global.document) {
      // eslint-disable-next-line @typescript-eslint/prefer-for-of
      for (let i = 0; i < document.scripts.length; i++) {
        // We go through all scripts on the page and look for 'data-entry'
        // We remember the name and measure the time between this script finished loading and
        // our mark 'sentry-tracing-init'
        if (document.scripts[i].dataset.entry === 'true') {
          entryScriptSrc = document.scripts[i].src;
          break;
        }
      }
    }

    let entryScriptStartTimestamp: number | undefined;
    let tracingInitMarkStartTime: number | undefined;

    global.performance
      .getEntries()
      .slice(this._performanceCursor)
      .forEach((entry: Record<string, any>) => {
        const startTime = msToSec(entry.startTime as number);
        const duration = msToSec(entry.duration as number);

        if (transaction.op === 'navigation' && timeOrigin + startTime < transaction.startTimestamp) {
          return;
        }

        switch (entry.entryType) {
          case 'navigation':
            addNavigationSpans(transaction, entry, timeOrigin);
            break;
          case 'mark':
          case 'paint':
          case 'measure': {
            const startTimestamp = addMeasureSpans(transaction, entry, startTime, duration, timeOrigin);
            if (tracingInitMarkStartTime === undefined && entry.name === 'sentry-tracing-init') {
              tracingInitMarkStartTime = startTimestamp;
            }

            // capture web vitals

            if (entry.name === 'first-paint') {
              logger.log('[Measurements] FP');
              this._measurements['fp'] = { value: entry.startTime };
              this._measurements['mark.fp'] = { value: startTimestamp };
            }

            if (entry.name === 'first-contentful-paint') {
              logger.log('[Measurements] Adding FCP');
              this._measurements['fcp'] = { value: entry.startTime };
              this._measurements['mark.fcp'] = { value: startTimestamp };
            }

            break;
          }
          case 'resource': {
            const resourceName = (entry.name as string).replace(window.location.origin, '');
            const endTimestamp = addResourceSpans(transaction, entry, resourceName, startTime, duration, timeOrigin);
            // We remember the entry script end time to calculate the difference to the first init mark
            if (entryScriptStartTimestamp === undefined && (entryScriptSrc || '').indexOf(resourceName) > -1) {
              entryScriptStartTimestamp = endTimestamp;
            }
            break;
          }
          default:
          // Ignore other entry types.
        }
      });

    if (entryScriptStartTimestamp !== undefined && tracingInitMarkStartTime !== undefined) {
      _startChild(transaction, {
        description: 'evaluation',
        endTimestamp: tracingInitMarkStartTime,
        op: 'script',
        startTimestamp: entryScriptStartTimestamp,
      });
    }

    this._performanceCursor = Math.max(performance.getEntries().length - 1, 0);

    // Measurements are only available for pageload transactions
    if (transaction.op === 'pageload') {
      transaction.setMeasurements(this._measurements);
    }
  }

  private _forceLCP: () => void = () => {
    /* No-op, replaced later if LCP API is available. */
    return;
  };

  /** Starts tracking the Largest Contentful Paint on the current page. */
  private _trackLCP(): void {
    // Based on reference implementation from https://web.dev/lcp/#measure-lcp-in-javascript.
    // Use a try/catch instead of feature detecting `largest-contentful-paint`
    // support, since some browsers throw when using the new `type` option.
    // https://bugs.webkit.org/show_bug.cgi?id=209216
    try {
      if (!PerformanceObserver.supportedEntryTypes.includes('largest-contentful-paint')) {
        return;
      }

      const updateLCP = (entry: PerformanceEntry): void => {
        // Only include an LCP entry if the page wasn't hidden prior to
        // the entry being dispatched. This typically happens when a page is
        // loaded in a background tab.
        if (entry.startTime < this._firstHiddenTime) {
          // NOTE: the `startTime` value is a getter that returns the entry's
          // `renderTime` value, if available, or its `loadTime` value otherwise.
          // The `renderTime` value may not be available if the element is an image
          // that's loaded cross-origin without the `Timing-Allow-Origin` header.
          const timeOrigin = msToSec(performance.timeOrigin);
          const startTime = msToSec(entry.startTime as number);
          logger.log('[Measurements] Adding LCP');
          this._measurements['lcp'] = { value: entry.startTime };
          this._measurements['mark.lcp'] = { value: timeOrigin + startTime };

          // TODO: when measurements has matured, include entry.id and entry.size
        } else {
          this._lcpFinal = true;
        }
      };

      // Create a PerformanceObserver that calls `updateLCP` for each entry.
      const po = new PerformanceObserver(entryList => {
        entryList.getEntries().forEach(updateLCP);
      });

      // Observe entries of type `largest-contentful-paint`, including buffered entries,
      // i.e. entries that occurred before calling `observe()` below.
      po.observe({
        buffered: true,
        type: 'largest-contentful-paint',
      });

      this._forceLCP = () => {
        if (po.takeRecords) {
          po.takeRecords().forEach(updateLCP);
        }
      };

      document.addEventListener(
        'visibilitychange',
        () => {

          if (this._lcpFinal) {
            return;
          }

          if (document.visibilityState === 'hidden') {
            if (po.takeRecords) {
              po.takeRecords().forEach(updateLCP);
              this._lcpFinal = true;
            }
          }

        },
        { capture: true, once: true },
      );
    } catch (e) {
      // Do nothing if the browser doesn't support this API.
    }
  }

  /** Starts tracking the First Input Delay on the current page. */
  private _trackFID(): void {
    // Based on reference implementation from https://web.dev/fid/#measure-fid-in-javascript.
    // Use a try/catch instead of feature detecting `first-input`
    // support, since some browsers throw when using the new `type` option.
    // https://bugs.webkit.org/show_bug.cgi?id=209216
    try {
      if (!PerformanceObserver.supportedEntryTypes.includes('first-input')) {
        return;
      }

      const updateFID = (entry: PerformanceEventTiming, po: PerformanceObserver): void => {
        // Only report FID if the page wasn't hidden prior to
        // the entry being dispatched. This typically happens when a
        // page is loaded in a background tab.
        if (entry.startTime < this._firstHiddenTime) {
          const fidValue = entry.processingStart - entry.startTime;
          const timeOrigin = msToSec(performance.timeOrigin);
          const startTime = msToSec(entry.startTime as number);
          logger.log('[Measurements] Adding FID');
          this._measurements['fid'] = { value: fidValue };
          this._measurements['mark.fid'] = { value: timeOrigin + startTime };

          po.disconnect();
        }
      };

      // Create a PerformanceObserver that calls `updateFID` for each entry.
      const po = new PerformanceObserver(entryList => {
        entryList.getEntries().forEach(entry => updateFID(entry as PerformanceEventTiming, po));
      });

      // Observe entries of type `first-input`, including buffered entries,
      // i.e. entries that occurred before calling `observe()` below.
      po.observe({
        buffered: true,
        type: 'first-input',
      });
    } catch (e) {
      // Do nothing if the browser doesn't support this API.
    }
  }
}

/** Instrument navigation entries */
function addNavigationSpans(transaction: Transaction, entry: Record<string, any>, timeOrigin: number): void {
  addPerformanceNavigationTiming(transaction, entry, 'unloadEvent', timeOrigin);
  addPerformanceNavigationTiming(transaction, entry, 'domContentLoadedEvent', timeOrigin);
  addPerformanceNavigationTiming(transaction, entry, 'loadEvent', timeOrigin);
  addPerformanceNavigationTiming(transaction, entry, 'connect', timeOrigin);
  addPerformanceNavigationTiming(transaction, entry, 'domainLookup', timeOrigin);
  addRequest(transaction, entry, timeOrigin);
}

/** Create measure related spans */
function addMeasureSpans(
  transaction: Transaction,
  entry: Record<string, any>,
  startTime: number,
  duration: number,
  timeOrigin: number,
): number {
  const measureStartTimestamp = timeOrigin + startTime;
  const measureEndTimestamp = measureStartTimestamp + duration;

  _startChild(transaction, {
    description: entry.name as string,
    endTimestamp: measureEndTimestamp,
    op: entry.entryType as string,
    startTimestamp: measureStartTimestamp,
  });

  return measureStartTimestamp;
}

export interface ResourceEntry extends Record<string, unknown> {
  initiatorType?: string;
  transferSize?: number;
  encodedBodySize?: number;
  decodedBodySize?: number;
}

/** Create resource related spans */
export function addResourceSpans(
  transaction: Transaction,
  entry: ResourceEntry,
  resourceName: string,
  startTime: number,
  duration: number,
  timeOrigin: number,
): number | undefined {
  // we already instrument based on fetch and xhr, so we don't need to
  // duplicate spans here.
  if (entry.initiatorType === 'xmlhttprequest' || entry.initiatorType === 'fetch') {
    return undefined;
  }

  const data: Record<string, any> = {};
  if ('transferSize' in entry) {
    data['Transfer Size'] = entry.transferSize;
  }
  if ('encodedBodySize' in entry) {
    data['Encoded Body Size'] = entry.encodedBodySize;
  }
  if ('decodedBodySize' in entry) {
    data['Decoded Body Size'] = entry.decodedBodySize;
  }

  const startTimestamp = timeOrigin + startTime;
  const endTimestamp = startTimestamp + duration;

  _startChild(transaction, {
    description: resourceName,
    endTimestamp,
    op: entry.initiatorType ? `resource.${entry.initiatorType}` : 'resource',
    startTimestamp,
    data,
  });

  return endTimestamp;
}

/** Create performance navigation related spans */
function addPerformanceNavigationTiming(
  transaction: Transaction,
  entry: Record<string, any>,
  event: string,
  timeOrigin: number,
): void {
  const end = entry[`${event}End`] as number | undefined;
  const start = entry[`${event}Start`] as number | undefined;
  if (!start || !end) {
    return;
  }
  _startChild(transaction, {
    description: event,
    endTimestamp: timeOrigin + msToSec(end),
    op: 'browser',
    startTimestamp: timeOrigin + msToSec(start),
  });
}

/** Create request and response related spans */
function addRequest(transaction: Transaction, entry: Record<string, any>, timeOrigin: number): void {
  _startChild(transaction, {
    description: 'request',
    endTimestamp: timeOrigin + msToSec(entry.responseEnd as number),
    op: 'browser',
    startTimestamp: timeOrigin + msToSec(entry.requestStart as number),
  });

  _startChild(transaction, {
    description: 'response',
    endTimestamp: timeOrigin + msToSec(entry.responseEnd as number),
    op: 'browser',
    startTimestamp: timeOrigin + msToSec(entry.responseStart as number),
  });
}

/**
 * Helper function to start child on transactions. This function will make sure that the transaction will
 * use the start timestamp of the created child span if it is earlier than the transactions actual
 * start timestamp.
 */
export function _startChild(transaction: Transaction, { startTimestamp, ...ctx }: SpanContext): Span {
  if (startTimestamp && transaction.startTimestamp > startTimestamp) {
    transaction.startTimestamp = startTimestamp;
  }

  return transaction.startChild({
    startTimestamp,
    ...ctx,
  });
}
