/// <reference path="../common/models.ts" />
/// <reference path="../common/messaging.ts" />
/// <reference path="config.ts" />
/// <reference path="utils.ts" />

import Models = require("../common/models");
import Messaging = require("../common/messaging");
import Utils = require("./utils");
import Statistics = require("./statistics");
import util = require("util");
import _ = require("lodash");
import Persister = require("./persister");
import Agent = require("./arbagent");
import mongodb = require('mongodb');
import FairValue = require("./fair-value");
import moment = require("moment");
import Interfaces = require("./interfaces");
import QuotingParameters = require("./quoting-parameters");

export class RegularFairValuePersister extends Persister.Persister<Models.RegularFairValue> {
    constructor(db: Q.Promise<mongodb.Db>) {
        super(db, "rfv", Persister.timeLoader, Persister.timeSaver);
    }
}

export class PositionManager {
    private _log: Utils.Logger = Utils.log("tribeca:rfv");

    public NewTargetPosition = new Utils.Evt();

    private _latest: number = null;
    public get latestTargetPosition(): number {
        return this._latest;
    }

    private _timer: RegularTimer;
    constructor(private _persister: Persister.IPersist<Models.RegularFairValue>,
        private _fvAgent: FairValue.FairValueEngine,
        private _data: Models.RegularFairValue[],
        private _shortEwma: Statistics.IComputeStatistics,
        private _longEwma: Statistics.IComputeStatistics) {
        var lastTime = (this._data !== null && _.any(_data)) ? _.last(this._data).time : null;
        this._timer = new RegularTimer(this.updateEwmaValues, moment.duration(1, 'hours'), lastTime);
    }

    private updateEwmaValues = () => {
        var fv = this._fvAgent.latestFairValue;
        if (fv === null)
            return;

        var rfv = new Models.RegularFairValue(Utils.date(), fv.price);

        var newShort = this._shortEwma.addNewValue(fv.price);
        var newLong = this._longEwma.addNewValue(fv.price);

        var newTargetPosition = (newShort - newLong) / 2.0;

        if (newTargetPosition > 1) newTargetPosition = 1;
        if (newTargetPosition < -1) newTargetPosition = -1;

        if (Math.abs(newTargetPosition - this._latest) > 1e-2) {
            this._latest = newTargetPosition;
            this.NewTargetPosition.trigger();
        }

        this._log("recalculated regular fair value, short:", Utils.roundFloat(newShort), "long:", Utils.roundFloat(newLong),
            "target:", Utils.roundFloat(this._latest), "currentFv:", Utils.roundFloat(fv.price));

        this._data.push(rfv);
        this._persister.persist(rfv);
    };
}

export class TargetBasePositionManager {
    private _log: Utils.Logger = Utils.log("tribeca:positionmanager");

    public NewTargetPosition = new Utils.Evt();

    private _latest: number = null;
    public get latestTargetPosition(): number {
        return this._latest;
    }

    constructor(private _positionManager: PositionManager,
        private _params: QuotingParameters.QuotingParametersRepository,
        private _positionBroker: Interfaces.IPositionBroker,
        private _wrapped: Messaging.IPublish<number>,
        private _persister: Persister.BasicPersister<Models.Timestamped<number>>) {
        _wrapped.registerSnapshot(() => [this._latest]);
        _positionBroker.NewReport.on(r => this.recomputeTargetPosition());
        _params.NewParameters.on(() => this.recomputeTargetPosition());
        _positionManager.NewTargetPosition.on(() => this.recomputeTargetPosition());
    }

    private recomputeTargetPosition = () => {
        var latestPosition = this._positionBroker.latestReport;
        var params = this._params.latest;

        if (params === null || latestPosition === null)
            return;

        var targetBasePosition: number = params.targetBasePosition;
        if (params.autoPositionMode === Models.AutoPositionMode.EwmaBasic) {
            targetBasePosition = ((1 + this._positionManager.latestTargetPosition) / 2.0) * latestPosition.value;
        }

        if (this._latest === null || Math.abs(this._latest - targetBasePosition) > 0.05) {
            this._latest = targetBasePosition;
            this.NewTargetPosition.trigger();

            this._wrapped.publish(this.latestTargetPosition);
            this._persister.persist(new Models.Timestamped(this.latestTargetPosition, Utils.date()));

            this._log("recalculated target base position:", Utils.roundFloat(this._latest));
        }
    };
}

// performs an action every duration apart, even across new instances
export class RegularTimer {
    constructor(private _action: () => void,
        private _diffTime: Duration,
        lastTime: Moment = null) {
        if (lastTime === null) {
            this.startTicking();
        }
        else {
            var timeout = lastTime.add(_diffTime).diff(Utils.date());

            if (timeout > 0) {
                setTimeout(this.startTicking, timeout)
            }
            else {
                this.startTicking();
            }
        }
    }

    private tick = () => {
        this._action();
    };

    private startTicking = () => {
        this.tick();
        setInterval(this.tick, this._diffTime.asMilliseconds());
    };
}