'use strict';
const Promise = require('promise');
const _ = require('lodash');
const zlog = require('zlog4js');

const logger = zlog.getLogger('core-transaction');


let transactionId = 1;
const transactions = {};

class TransactionHandler {
    constructor(thisTransaction) {
        this.id = thisTransaction.id;
        this.rollback = thisTransaction.rollback.bind(thisTransaction);
        this.startInner = thisTransaction.startInner.bind(thisTransaction);
        this.parent = thisTransaction.parentTransaction ? thisTransaction.parentTransaction.handler : null;

        // add to the transaction handler all additional methods of the custom implementation and potentiallly inherited implementation;
        const thisObj = this;
        _.forEach(getInstanceMethods(thisTransaction, Transaction.prototype), (m) => {
            thisObj[m.name] = delegateToTransactionMethod(m.method);
        });

        function delegateToTransactionMethod(method) {
            return (...params) => method.apply(thisTransaction, params);
        }
    }
}

function getInstanceMethods(obj, stop) {
    const array = [];
    let proto = Object.getPrototypeOf(obj);
    while (proto && proto !== stop) {
      Object.getOwnPropertyNames(proto).forEach(name => {
          if (name !== 'constructor') {
            if (hasMethod(proto, name)) {
              array.push({name: name, method: proto[name]});
            }
          }
        });
      proto = Object.getPrototypeOf(proto);
    }
    return array;

    function hasMethod(obj, name) {
        const desc = Object.getOwnPropertyDescriptor(obj, name);
        return !!desc && typeof desc.value === 'function';
    }
}

class Transaction {
    constructor(parentTransaction, implementation, options) {
        if (arguments.length !== 3 || !_.isObject(options))
            throw new Error('Missing constructor parameters in your transaction implementation');
        const thisTransaction = this;
        this.innerTransactions = [];
        this.innerCommitStack = [];
        this.status = 'running';
        this.options = options;
        this.id = transactionId++;
        this.logger = logger;

        if (parentTransaction) {
            constructInnerTransaction(
                thisTransaction,
                parentTransaction,
                options.name,
                implementation.processInnerBegin,
                implementation.processInnerCommit,
                implementation.processInnerRollback);
        } else {
            constructMainTransaction(
                thisTransaction,
                parentTransaction,
                options.name,
                implementation.processBegin,
                implementation.processCommit,
                implementation.processRollback);
        }
    }

    getLogger() {
        return logger;
    }

    startInner(innerOptions) {
        return createTransaction(this, _.assign({DefaultImplementationClass: this.options.DefaultImplementationClass}, innerOptions));
    }


    rollback(err) {
        this.status = 'rolledback';
        throw err || new Error('ROLL_BACK');
    }


    execute(processFn) {
        const thisTransaction = this;
        const impl = this.impl;
        let processResult;

        return processBegin()
            .then(processExecution)
            .then(processCommit)
            .then(() => processResult)
            .catch(processRollback);


        function processBegin() {
            thisTransaction.logger.info('%s - Begin.', thisTransaction.display);
            let result;
            try {
                result = impl.processBegin();
            } catch (err) {
                // programmer error
                return Promise.reject(err);
            }
            return Promise.resolve(result);
        }


        function processExecution() {
            thisTransaction.handler = new TransactionHandler(thisTransaction);

            const result = processFn(thisTransaction.handler);
            if (!_.isObject(result) || !_.isFunction(result.then))
                return Promise.reject('TRANSACTION_EXECUTION_NOT_RETURNING_A_PROMISE');
            processResult = result;
            return result;
        }

        function processCommit(result) {
            // if inner transaction has not committed
            // it means a transaction was started parrallely, and the code is not waiting for its completion
            // unfortunately, if the inner transaction finished before the main commits, it will not be detected
            if (_.some(thisTransaction.innerTransactions, (trans) => trans.status === 'running')) {
                thisTransaction.logger.error('%s - Transaction is committing before an inner transaction completed.', thisTransaction.display);
                throw new Error('INNER_TRANSACTION_NOT_AWAITED');
            }

            if (thisTransaction.parentTransaction && thisTransaction.parentTransaction.status !== 'running') {
                thisTransaction.logger.error('%s - Inner Transaction is committing after its parent transaction.', thisTransaction.display);
                throw new Error('INNER_TRANSACTION_NOT_AWAITED');
            }

            if (_.some(thisTransaction.innerTransactions, (trans) => trans.status === 'rolledback')) {
                throw new Error('INNER_TRANSACTION_ROLLED_BACK');
            }

            thisTransaction.logger.info('%s - Commit.', thisTransaction.display);
            Promise.resolve(impl.processCommit(thisTransaction))
                .then(() => {
                    onCommit(result);
                });

            thisTransaction.status = 'committed';

            if (thisTransaction.parentTransaction)
                _.remove(thisTransaction.parentTransaction.innerTransactions, thisTransaction);

            return result;

            function onCommit(result) {
                if (!thisTransaction.options.onCommit) return;

                 // the onCommit shall be exectured only when the main transaction commit !!!!!!
                 if (thisTransaction.parentTransaction) {
                    Array.prototype.push.apply(thisTransaction.parentTransaction.innerCommitStack, thisTransaction.innerCommitStack);
                    thisTransaction.parentTransaction.innerCommitStack.push(() => callback(result));
                } else {
                    _.forEach(thisTransaction.innerCommitStack, (fn) => fn());
                    callback(result);
                }

                function callback(result) {
                    try {
                        thisTransaction.logger.info('%s - on commit.', thisTransaction.display);
                        return Promise.resolve(thisTransaction.options.onCommit.call(thisTransaction, result, thisTransaction))
                        .catch((err) => {
                            thisTransaction.logger.error('%s - irrecoverable failure as on Commit failed', thisTransaction.display, err);
                        });
                    } catch (err) {
                        thisTransaction.logger.error('%s - irrecoverable failure as on Commit failed', thisTransaction.display, err);
                    }
                }
            }
        }


        function processRollback(err) {
            thisTransaction.logger.warn('%s - Roll back.', thisTransaction.display, err.message || err);
            thisTransaction.logger.trace('%s - Roll back Error.', thisTransaction.display, err.stack || err);
            Promise.resolve(impl.processRollback(err))
                .then(() => onRollback());
            thisTransaction.rollback(err);
            return;


            function onRollback() {
                if (!thisTransaction.options.onRollback) return;
                thisTransaction.logger.info('%s - on rollback.', thisTransaction.display);
                try {
                    Promise.resolve(thisTransaction.options.onRollback.bind(thisTransaction)())
                    .catch((err) => {
                        thisTransaction.logger.error('%s - irrecoverable failure as on rollback failed', thisTransaction.display, err);
                    });
                } catch (err) {
                    thisTransaction.logger.error('%s - irrecoverable failure as on rollback failed', thisTransaction.display, err);
                }
            }
        }
    }
}

function constructInnerTransaction(thisTransaction, parentTransaction, name, processBegin, processCommit, processRollback) {
    thisTransaction.parentTransaction = parentTransaction;
    thisTransaction.level = parentTransaction.level + 1;
    thisTransaction.impl = {
        processBegin,
        processCommit,
        processRollback,
        parentTransaction
    };
    parentTransaction.innerTransactions.push(thisTransaction);
    thisTransaction.name = parentTransaction.name + '/' + (name || ('Level ' + thisTransaction.level));
    thisTransaction.display = formatName(thisTransaction.name);
}

function constructMainTransaction(thisTransaction, parentTransaction, name, processBegin, processCommit, processRollback) {
    thisTransaction.level = 0;
    thisTransaction.impl = {
        processBegin,
        processCommit,
        processRollback,
        parentTransaction
    };
    thisTransaction.name = (name || 'id') + ' #' + thisTransaction.id;
    thisTransaction.display = formatName(thisTransaction.name);
}


function formatName(composed) {
    return 'System Trans ['+ composed +']';
}


class DefaultTransactionImplementationClass extends Transaction {
    constructor(parentTransaction, options) {
        super(
            parentTransaction, {
                processBegin: _.noop,
                processCommit: _.noop,
                processRollback: _.noop,
                processInnerBegin: _.noop,
                processInnerCommit: _.noop,
                processInnerRollback: _.noop
            },
            options);
    }
}

/**
 * return transaction('REUSE_OR_NEW',parentTransaction,{
 *      name: 'Important transaction'
 *      enablePartialCommit: true // not implemented
 *      onCommit: () => {
 *          console.info('This is executed after main transaction has committed)
 *      }
 * })
 *        .execute(() => service.update.bind(transaction)(args))
 *        .then(() => console.info('it is committed'))
 *        .catch(() => console.info('it is rolled back'))
 * @param {*} requirement can be REUSE or NEW or REUSE_OR_NEW
 * @param {*} parentTransactionHandler
 * @param {*} options // this is passed to the transaction implementation
 *      - implementationClass is the transaction class to instantiate
 *      - onCommit is the callback called after commit
 *      - onRollback is the callback called after rollback
 */
function defineTransaction(requirement, parentTransactionHandler, options) {
    let parentTransaction;

    // Typical use of requirements
    switch (requirement) {
        case 'REUSE':
            if (!parentTransactionHandler || !(parentTransactionHandler instanceof TransactionHandler)) throw new Error('PARENT_TRANSACTION_NOT_PROVIDED');
            parentTransaction = transactions[parentTransactionHandler.id];
            break;
        case 'NEW':
            if (parentTransactionHandler instanceof TransactionHandler) throw new Error('PARENT_TRANSACTION_MAY_NOT_BE_PROVIDED');
            if (arguments.length === 2) {
                options = parentTransactionHandler;
            }
            parentTransactionHandler = null;
            break;
        case 'REUSE_OR_NEW':
            if (parentTransactionHandler && !(parentTransactionHandler instanceof TransactionHandler))
                parentTransactionHandler = null;
            break;
        default:
            throw new Error('TRANSACTION_REQUIREMENT_UNKNOWN');
    }

    options = _.assign({DefaultImplementationClass: DefaultTransactionImplementationClass}, options);
    return createTransaction(parentTransaction, options);
}


function createTransaction(parentTransaction, innerOptions) {
    const Impl = innerOptions.implementationClass || innerOptions.DefaultImplementationClass || DefaultTransactionImplementationClass;
    const transaction = new Impl(parentTransaction, innerOptions);
    transactions[transaction.id] = transaction;
    return {
        then: (callback) => transaction.execute(callback).finally(() => delete transactions[transaction.id]),
        execute: (callback) => transaction.execute(callback).finally(() => delete transactions[transaction.id]),
    };
}

function startTransaction(options) {
    return defineTransaction('NEW', options);
}

function reUseOrCreateTransaction() {
    return defineTransaction('REUSE_OR_NEW', parentTransaction, options);
}

function getCoreTransactionClass() {
    return Transaction;
}

function setTransactionImplementationClass(implClass) {
    DefaultTransactionImplementationClass = implClass;
}

module.exports = {
    defineTransaction,
    startTransaction,
    reUseOrCreateTransaction,
    getCoreTransactionClass,
    setTransactionImplementationClass
};


