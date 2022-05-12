const ServiceManagerTypes = require("../helpers/serviceManagerTypes");
const SwitchAccessory = require("./switch");
const catchDelayCancelError = require("../helpers/catchDelayCancelError");
const delayForDuration = require("../helpers/delayForDuration");

class FanAccessory extends SwitchAccessory {
  setDefaults() {
    super.setDefaults();
    let { config, state } = this;

    state.lastStep = Math.ceil((state.fanSpeed / 100) * 24);
    this.locked = false;

    // Defaults
    config.showSwingMode =
      config.hideSwingMode === true || config.showSwingMode === false
        ? false
        : true;
    config.showRotationDirection =
      config.hideRotationDirection === true ||
      config.showRotationDirection === false
        ? false
        : true;
    config.stepSize =
      isNaN(config.stepSize) || config.stepSize > 100 || config.stepSize < 1
        ? 1
        : config.stepSize;

    if (config.speedSteps) {
      config.stepSize = Math.floor(100 / config.speedSteps);
    }

    if (config.alwaysResetToDefaults) {
      state.fanSpeed =
        config.defaultFanSpeed !== undefined ? config.defaultFanSpeed : 100;

      if (config.defaultSpeedStep && config.stepSize) {
        state.fanSpeed = config.defaultSpeedStep * config.stepSize;
      }
    }
  }

  reset() {
    super.reset();

    this.stateChangeInProgress = true;

    // Clear Timeouts
    if (this.delayTimeoutPromise) {
      this.delayTimeoutPromise.cancel();
      this.delayTimeoutPromise = null;
    }

    if (this.autoOffTimeoutPromise) {
      this.autoOffTimeoutPromise.cancel();
      this.autoOffTimeoutPromise = null;
    }

    if (this.autoOnTimeoutPromise) {
      this.autoOnTimeoutPromise.cancel();
      this.autoOnTimeoutPromise = null;
    }

    if (
      this.serviceManager.getCharacteristic(Characteristic.Active) === undefined
    ) {
      this.serviceManager.setCharacteristic(Characteristic.Active, false);
    }
  }

  checkAutoOnOff() {
    this.reset();
    this.checkAutoOn();
    this.checkAutoOff();
  }

  async checkAutoOff() {
    await catchDelayCancelError(async () => {
      const { config, log, logLevel, name, state, serviceManager } = this;
      let { disableAutomaticOff, enableAutoOff, onDuration } = config;

      if (state.switchState && enableAutoOff) {
        if (logLevel <= 2) {
          log(
            `${name} setSwitchStateOff: (automatically turn off in ${onDuration} seconds)`
          );
        }

        this.autoOffTimeoutPromise = delayForDuration(onDuration);
        await this.autoOffTimeoutPromise;

        serviceManager.setCharacteristic(Characteristic.Active, false);
      }
    });
  }

  async checkAutoOn() {
    await catchDelayCancelError(async () => {
      const { config, log, logLevel, name, state, serviceManager } = this;
      let { disableAutomaticOn, enableAutoOn, offDuration } = config;

      if (!state.switchState && enableAutoOn) {
        if (logLevel <= 2) {
          log(
            `${name} setSwitchStateOn: (automatically turn on in ${offDuration} seconds)`
          );
        }

        this.autoOnTimeoutPromise = delayForDuration(offDuration);
        await this.autoOnTimeoutPromise;

        serviceManager.setCharacteristic(Characteristic.Active, true);
      }
    });
  }

  async setSwitchState(hexData, previousValue) {
    const { config, state, serviceManager, log } = this;

    if (!this.state.switchState) {
      this.lastFanSpeed = undefined;
    }

    // do not try to turn on if already on
    if (!!previousValue && !!this.state.switchState) {
      log(`already on. skip sending ${hexData}`);
      return;
    }

    // reset swingMode to default when turned off
    if (!!this.state.switchState) {
      serviceManager.setCharacteristic(
        Characteristic.SwingMode,
        0
      );
    }

    if (config.defaultSpeedStep && config.stepSize) {
      this.lastFanSpeed = config.defaultSpeedStep * config.stepSize;
    }

    // Reset the fan speed back to the default speed when turned off
    if (this.state.switchState === false && config.alwaysResetToDefaults) {
      this.setDefaults();
      serviceManager.setCharacteristic(
        Characteristic.RotationSpeed,
        state.fanSpeed
      );
    }

    

    super.setSwitchState(hexData, previousValue);
  }

  async setFanSpeed(hexData) {
    const { config, data, host, log, state, name, logLevel } = this;
    const fanSpeedUpHex = data.fanSpeedUp;
    const fanSpeedDownHex = data.fanSpeedDown;
    const minStep = 1;  // 1%
    const maxStep = 24; // 100%

    if (this.locked) {
      return;
    }
    this.locked = true;
    log(`lock acquired`);

    if (state.lastStep === undefined) {
      log(`lock return`);
      return;
    }

    this.reset();

    // 60% -> 100%
    
    const newStep = Math.round((state.fanSpeed / 100) * maxStep);
    const diffStep = newStep - state.lastStep;
    const fanSpeedHex = diffStep >= 0 ? fanSpeedUpHex : fanSpeedDownHex;
    hexData = [{
      "data": fanSpeedHex,
      "sendCount": Math.abs(diffStep),
      "interval": 0.5,
      "pause": 0
    }]
    log(`prevStep: ${state.lastStep}, newStep: ${newStep}, diffStep: ${diffStep}`);
    state.lastStep = newStep;

    log(`perform send ${JSON.stringify(hexData)}`)
    await this.performSend(hexData).then(()=>{
        this.locked = false;
        state.lastStep = newStep; // update again
        log(`unlocked`);
    });
    
    this.checkAutoOnOff();
  }

  setupServiceManager() {
    const { config, data, name, serviceManagerType } = this;
    const {
      on,
      off,
      clockwise,
      counterClockwise,
      swingToggleOn,
      swingToggleOff,
    } = data || {};

    this.serviceManager = new ServiceManagerTypes[serviceManagerType](
      name,
      Service.Fanv2,
      this.log
    );

    this.setDefaults();

    this.serviceManager.addToggleCharacteristic({
      name: "switchState",
      type: Characteristic.Active,
      getMethod: this.getCharacteristicValue,
      setMethod: this.setCharacteristicValue,
      bind: this,
      props: {
        onData: on,
        offData: off,
        setValuePromise: this.setSwitchState.bind(this),
      },
    });

    if (config.showSwingMode) {
      this.serviceManager.addToggleCharacteristic({
        name: "swingMode",
        type: Characteristic.SwingMode,
        getMethod: this.getCharacteristicValue,
        setMethod: this.setCharacteristicValue,
        bind: this,
        props: {
          onData: swingToggleOn,
          offData: swingToggleOff,
          setValuePromise: this.performSend.bind(this),
        },
      });
    }

    this.serviceManager.addToggleCharacteristic({
      name: "fanSpeed",
      type: Characteristic.RotationSpeed,
      getMethod: this.getCharacteristicValue,
      setMethod: this.setCharacteristicValue,
      bind: this,
      props: {
        setValuePromise: this.setFanSpeed.bind(this),
        minStep: config.stepSize,
        minValue: 0,
        maxValue: 100,
      },
    });

    if (config.showRotationDirection) {
      this.serviceManager.addToggleCharacteristic({
        name: "rotationDirection",
        type: Characteristic.RotationDirection,
        getMethod: this.getCharacteristicValue,
        setMethod: this.setCharacteristicValue,
        bind: this,
        props: {
          onData: counterClockwise,
          offData: clockwise,
          setValuePromise: this.performSend.bind(this),
        },
      });
    }
  }
}

module.exports = FanAccessory;
