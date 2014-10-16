/// <reference path="models.ts" />

class Result {
    constructor(public restSide: Side, public restBroker: IBroker,
                public hideBroker: IBroker, public profit: number,
                public rest: MarketSide, public hide: MarketSide) {}
}

class OrderBrokerAggregator {
    _brokers : Array<IBroker>;
    _log : Logger = log("Hudson:BrokerAggregator");
    _ui : UI;
    _brokersByExch : { [exchange: number]: IBroker} = {};

    constructor(brokers : Array<IBroker>, ui : UI) {
        this._brokers = brokers;
        this._ui = ui;

        this._brokers.forEach(b => {
            b.OrderUpdate.on(this._ui.sendOrderStatusUpdate);
        });

        for (var i = 0; i < brokers.length; i++)
            this._brokersByExch[brokers[i].exchange()] = brokers[i];

        this._ui.NewOrder.on(this.submitOrder);
        this._ui.CancelOrder.on(this.cancelOrder);
    }

    public brokers = () => {
        return this._brokers;
    };

    public submitOrder = (o : SubmitNewOrder) => {
        try {
            this._brokersByExch[o.exchange].sendOrder(o);
        }
        catch (e) {
            this._log("Exception while sending order", o, e);
        }
    };

    public cancelReplaceOrder = (o : CancelReplaceOrder) => {
        try {
            this._brokersByExch[o.exchange].replaceOrder(o);
        }
        catch (e) {
            this._log("Exception while cancel/replacing order", o, e);
        }
    };

    public cancelOrder = (o : OrderCancel) => {
        try {
            this._brokersByExch[o.exchange].cancelOrder(o);
        }
        catch (e) {
            this._log("Exception while cancelling order", o, e);
        }
    };
}

class Agent {
    _brokers : Array<IBroker>;
    _log : Logger = log("Hudson:Agent");
    _ui : UI;

    constructor(brokers : Array<IBroker>, ui : UI) {
        this._brokers = brokers;
        this._ui = ui;

        this._brokers.forEach(b => {
            b.MarketData.on(this.onNewMarketData);
        });
    }

    private onNewMarketData = (book : MarketBook) => {
        this.recalcMarkets(book);
        this._ui.sendUpdatedMarket(book);
    };

    private recalcMarkets = (book : MarketBook) => {
        var activeBrokers = this._brokers.filter(b => b.currentBook() != null);

        if (activeBrokers.length <= 1)
            return;

        var results : Result[] = [];
        activeBrokers.filter(b => b.makeFee() < 0)
            .forEach(restBroker => {
                activeBrokers.forEach(hideBroker => {
                    if (restBroker.exchange() == hideBroker.exchange()) return;

                    // need to determine whether or not I'm already on the market
                    var restTop = restBroker.currentBook().top;
                    var hideTop = hideBroker.currentBook().top;

                    var pBid = -(1 + restBroker.makeFee()) * restTop.bid.price + (1 + hideBroker.takeFee()) * hideTop.bid.price;
                    var pAsk = +(1 + restBroker.makeFee()) * restTop.ask.price - (1 + hideBroker.takeFee()) * hideTop.ask.price;

                    if (pBid > 0) {
                        var p = Math.min(restTop.bid.size, hideTop.bid.size);
                        results.push(new Result(Side.Bid, restBroker, hideBroker, pBid * p, restTop.bid, hideTop.bid));
                    }

                    if (pAsk > 0) {
                        var p = Math.min(restTop.ask.size, hideTop.ask.size);
                        results.push(new Result(Side.Ask, restBroker, hideBroker, pAsk * p, restTop.ask, hideTop.ask));
                    }
                })
            });

        if (results.length == 0) return;

        var bestResult : Result;
        var bestProfit: number = Number.MIN_VALUE;
        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            if (bestProfit < r.profit) {
                bestProfit = r.profit;
                bestResult = r;
            }
        }

        // 1 - new order
        // 2 - cxl-rep
        // 3 - cxl

        this._log("Trigger p=%d > %s Rest (%s) %d :: Hide (%s) %d", bestResult.profit, Side[bestResult.restSide],
            bestResult.restBroker.name(), bestResult.rest.price, bestResult.hideBroker.name(), bestResult.hide.price);


    };
}