/* Copyright 2020 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

class Event {
  constructor(data) {
    this.change = data.change || "";
    this.changeEx = data.changeEx || null;
    this.commitKey = data.commitKey || 0;
    this.fieldFull = data.fieldFull || false;
    this.keyDown = data.keyDown || false;
    this.modifier = data.modifier || false;
    this.name = data.name;
    this.rc = true;
    this.richChange = data.richChange || [];
    this.richChangeEx = data.richChangeEx || [];
    this.richValue = data.richValue || [];
    this.selEnd = data.selEnd ?? -1;
    this.selStart = data.selStart ?? -1;
    this.shift = data.shift || false;
    this.source = data.source || null;
    this.target = data.target || null;
    this.targetName = "";
    this.type = "Field";
    this.value = data.value || "";
    this.willCommit = data.willCommit || false;
  }
}

class EventDispatcher {
  constructor(document, calculationOrder, objects) {
    this._document = document;
    this._calculationOrder = calculationOrder;
    this._objects = objects;

    this._document.obj._eventDispatcher = this;
    this._isCalculating = false;
  }

  mergeChange(event) {
    let value = event.value;
    if (Array.isArray(value)) {
      return value;
    }
    if (typeof value !== "string") {
      value = value.toString();
    }
    const prefix =
      event.selStart >= 0 ? value.substring(0, event.selStart) : "";
    const postfix =
      event.selEnd >= 0 && event.selEnd <= value.length
        ? value.substring(event.selEnd)
        : "";

    return `${prefix}${event.change}${postfix}`;
  }

  dispatch(baseEvent) {
    const id = baseEvent.id;
    if (!(id in this._objects)) {
      let event;
      if (id === "doc" || id === "page") {
        event = globalThis.event = new Event(baseEvent);
        event.source = event.target = this._document.wrapped;
        event.name = baseEvent.name;
      }
      if (id === "doc") {
        this._document.obj._dispatchDocEvent(event.name);
      } else if (id === "page") {
        this._document.obj._dispatchPageEvent(
          event.name,
          baseEvent.actions,
          baseEvent.pageNumber
        );
      } else if (id === "app" && baseEvent.name === "ResetForm") {
        for (const fieldId of baseEvent.ids) {
          const obj = this._objects[fieldId];
          if (obj) {
            obj.obj._reset();
          }
        }
      }
      return;
    }

    const name = baseEvent.name;
    const source = this._objects[id];
    const event = (globalThis.event = new Event(baseEvent));
    let savedChange;

    if (source.obj._isButton()) {
      source.obj._id = id;
      event.value = source.obj._getExportValue(event.value);
      if (name === "Action") {
        source.obj._value = event.value;
      }
    }

    switch (name) {
      case "Keystroke":
        savedChange = {
          value: event.value,
          change: event.change,
          selStart: event.selStart,
          selEnd: event.selEnd,
        };
        break;
      case "Blur":
      case "Focus":
        Object.defineProperty(event, "value", {
          configurable: false,
          writable: false,
          enumerable: true,
          value: event.value,
        });
        break;
      case "Validate":
        this.runValidation(source, event);
        return;
      case "Action":
        this.runActions(source, source, event, name);
        this.runCalculate(source, event);
        return;
    }

    this.runActions(source, source, event, name);

    if (name !== "Keystroke") {
      return;
    }

    if (event.rc) {
      if (event.willCommit) {
        this.runValidation(source, event);
      } else {
        const value = (source.obj.value = this.mergeChange(event));
        let selStart, selEnd;
        if (
          event.selStart !== savedChange.selStart ||
          event.selEnd !== savedChange.selEnd
        ) {
          // Selection has been changed by the script so apply the changes.
          selStart = event.selStart;
          selEnd = event.selEnd;
        } else {
          selEnd = selStart = savedChange.selStart + event.change.length;
        }
        source.obj._send({
          id: source.obj._id,
          value,
          selRange: [selStart, selEnd],
        });
      }
    } else if (!event.willCommit) {
      source.obj._send({
        id: source.obj._id,
        value: savedChange.value,
        selRange: [savedChange.selStart, savedChange.selEnd],
      });
    } else {
      // Entry is not valid (rc == false) and it's a commit
      // so just clear the field.
      source.obj._send({
        id: source.obj._id,
        value: "",
        formattedValue: null,
        selRange: [0, 0],
      });
    }
  }

  runValidation(source, event) {
    const didValidateRun = this.runActions(source, source, event, "Validate");
    if (event.rc) {
      source.obj.value = event.value;

      this.runCalculate(source, event);

      const savedValue = (event.value = source.obj.value);
      let formattedValue = null;

      if (this.runActions(source, source, event, "Format")) {
        formattedValue = event.value;
      }

      source.obj._send({
        id: source.obj._id,
        value: savedValue,
        formattedValue,
      });
      event.value = savedValue;
    } else if (didValidateRun) {
      // The value is not valid.
      source.obj._send({
        id: source.obj._id,
        value: "",
        formattedValue: null,
        selRange: [0, 0],
      });
    }
  }

  runActions(source, target, event, eventName) {
    event.source = source.wrapped;
    event.target = target.wrapped;
    event.name = eventName;
    event.targetName = target.obj.name;
    event.rc = true;

    return target.obj._runActions(event);
  }

  calculateNow() {
    // This function can be called by a JS script (doc.calculateNow()).
    // If !this._calculationOrder then there is nothing to calculate.
    // _isCalculating is here to prevent infinite recursion with calculateNow.
    // If !this._document.obj.calculate then the script doesn't want to have
    // a calculate.

    if (
      !this._calculationOrder ||
      this._isCalculating ||
      !this._document.obj.calculate
    ) {
      return;
    }
    this._isCalculating = true;
    const first = this._calculationOrder[0];
    const source = this._objects[first];
    globalThis.event = new Event({});

    try {
      this.runCalculate(source, globalThis.event);
    } catch (error) {
      this._isCalculating = false;
      throw error;
    }

    this._isCalculating = false;
  }

  runCalculate(source, event) {
    // _document.obj.calculate is equivalent to doc.calculate and can be
    // changed by a script to allow a future calculate or not.
    // This function is either called by calculateNow or when an action
    // is triggered (in this case we cannot be currently calculating).
    // So there are no need to check for _isCalculating because it has
    // been already done in calculateNow.
    if (!this._calculationOrder || !this._document.obj.calculate) {
      return;
    }

    for (const targetId of this._calculationOrder) {
      if (!(targetId in this._objects)) {
        continue;
      }

      if (!this._document.obj.calculate) {
        // An action could have changed calculate value.
        break;
      }

      event.value = null;
      const target = this._objects[targetId];
      let savedValue = target.obj.value;
      this.runActions(source, target, event, "Calculate");
      if (!event.rc) {
        continue;
      }

      if (event.value !== null) {
        // A new value has been calculated so set it.
        target.obj.value = event.value;
      }

      event.value = target.obj.value;
      this.runActions(target, target, event, "Validate");
      if (!event.rc) {
        if (target.obj.value !== savedValue) {
          target.wrapped.value = savedValue;
        }
        continue;
      }

      savedValue = event.value = target.obj.value;
      let formattedValue = null;
      if (this.runActions(target, target, event, "Format")) {
        formattedValue = event.value;
      }

      target.obj._send({
        id: target.obj._id,
        value: savedValue,
        formattedValue,
      });
    }
  }
}

export { Event, EventDispatcher };
