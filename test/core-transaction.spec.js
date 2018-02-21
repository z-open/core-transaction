'use strict';
const Promise = require('promise');
const _ = require('lodash');
const {startTransaction, setTransactionImplementationClass, getCoreTransactionClass} = require('../lib/core-transaction');

let onCommitOption, onRollbackOption;

describe('abstract transaction', () => {
    const successfullProcess = () => Promise.resolve();
    const failedProcess = () => Promise.reject('A PROCESS ERROR');

    const failedProcessWithNotifications = () => Promise.reject('A PROCESS ERROR');

    beforeEach(() => {
        class TransactionImplementation extends getCoreTransactionClass() {
            constructor(parentTransaction, options) {
                super(parentTransaction, {
                    processBegin: _.noop,
                    processCommit: _.noop,
                    processRollback: _.noop,
                    processInnerBegin: _.noop,
                    processInnerCommit: _.noop,
                    processInnerRollback: _.noop
                },
                options);
            }

            query() {
                return Promise.resolve('test '+ this.id);
            }
        }

        onCommitOption = jasmine.createSpy().and.callFake(() => true);
        onRollbackOption = jasmine.createSpy().and.callFake(() => true);
        setTransactionImplementationClass(TransactionImplementation);
    });

    it('should commit', (done) => {
        startTransaction()
        .execute(successfullProcess)
        .then(done)
        .catch((err) => done.fail(err));
    });

    it('should execute custom implementation method query and commit', (done) => {
        let handler;
        startTransaction()
        .execute((_handler) => {
            handler = _handler;
            return handler.query();
        })
        .then((result) => {
            expect(result).toBe('test ' + handler.id);
            done();
        })
        .catch((err) => done.fail(err));
    });

    it('should commit and call the onCommit option', (done) => {
        startTransaction( {
            onCommit: onCommitOption,
            onRollback: onRollbackOption
        })
        .execute(successfullProcess)
        .then(() => {
            expect(onCommitOption).toHaveBeenCalled();
            expect(onRollbackOption).not.toHaveBeenCalled();
            done();
        })
        .catch((err) => done.fail(err));
    });

    it('should rollback', (done) => {
        startTransaction()
        .execute(failedProcess)
        .then(() => done.fail('should have rolled back'))
        .catch(done);
    });

    it('should rollback and call onRollback option', (done) => {
        startTransaction( {
            onCommit: onCommitOption,
            onRollback: onRollbackOption
        })
        .execute(failedProcess)
        .then(() => done.fail('should have rolled back'))
        .catch(() => {
            expect(onCommitOption).not.toHaveBeenCalled();
            expect(onRollbackOption).toHaveBeenCalled();
            done();
        });
    });

    it('should commit all transactions', (done) => {
        startTransaction()
        .execute((transaction) => {
            return transaction.startInner()
                .execute(successfullProcess);
        })
        .then(done)
        .catch((err) => done.fail(err));
    });

    it('should rollback due to inner transaction rollback', (done) => {
        startTransaction()
        .execute((transaction) => {
            return transaction.startInner()
                .execute(failedProcess);
        })
        .then(() => done.fail('should have rolled back'))
        .catch(done);
    });

    it('should rollback due to inner transaction rollback even if the inner transaction promise does not reject', (done) => {
        startTransaction()
        .execute((transaction) => {
            return transaction.startInner()
                .execute(failedProcessWithNotifications)
                .catch((err) => {
                    return err; // promise does not reject anymore
                });
        })
        .then(() => done.fail('should have rolled back'))
        .catch(() => {
            expect(onCommitOption).not.toHaveBeenCalled();
            // expect(onCommitOption.calls.count()).toEquals(0);
            done();
        });
    });

    it('should fail due to a transaction process not returning a promise', (done) => {
        startTransaction()
        .execute((transaction) => {
            // there is no return
            transaction.startInner()
                .execute(failedProcessWithNotifications);
        })
        .then(() => done.fail('should have rolled back'))
        .catch((err) => {
            expect(err).toEqual('TRANSACTION_EXECUTION_NOT_RETURNING_A_PROMISE');
            done();
        });
    });

    it('should commit all transactions but display an error due inner transaction not awaited', (done) => {
        startTransaction()
        .execute((transaction) => {
            // there is no return
            setTimeout(() =>
            transaction.startInner()
                .execute(successfullProcess),
                1000);
            return Promise.resolve();
        })
        .then(() => done())
        .catch(() => {
            done.fail('Should have been able to commit both transaction, but there is an error on the console');
        });
    });

    it('should not commit the main transaction due to inner transaction has not completed and was not awaited', (done) => {
        startTransaction()
        .execute((transaction) => {
            // there is no return
            transaction.startInner()
                .execute(setTimeout(() => successfullProcess(),
                1000));
            return Promise.resolve();
        })
        .then(() => done.fail('should have rolled back the main transaction'))
        .catch((err) => {
            expect(err).toEqual(new Error('INNER_TRANSACTION_NOT_AWAITED'));
            done();
        });
    });
});

