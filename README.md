# core-transaction

## Description

This npm package provides transactional support to processes via chain of promises in a node application.
You must provide the implementation of the transaction supporting your resource.
Though it provides a basic transaction implementation, whose commit and rollback do not do anything.

___Example of simple transaction___

The defined transaction will execute the code block and return a promise with its state

```javascript
const {startTransaction} = require('core-transaction');

startTransaction()
    .then((transaction) => service.update(transaction,args))
    .then((result) => console.info('it is committed'))
    .catch((error) => console.info('it is rolled back'))
```


___Example of inner transaction rollback___

When a transaction is defined within another transaction, the parent transaction can handle inner transaction failures.
By default if an inner transaction rolls back, the main will rollback.

but if the promise of a rolled back inner transaction resolves. Only the inner transaction will rollback, not the parent transaction.

Here we force the rollback by call calling rollback().
If the transactional code throws an error, this will also trigger the rollback.


```javascript
const {startTransaction} = require('core-transaction');

const promise = startTransaction()
    .then((transaction) => runInnerTransaction(transaction))
    .catch(() => console.info('it is rolled back'))


function runInnerTransaction(parentTransaction)
    return parentTransaction.startInner()
        .then((transaction) => transaction.rollback()))
        .catch((err) => {
            console.info('it is rolled back')
            // the parent transaction will roll back only if it is rejected or thrown.
            throw err;
        );
}
```

___Example when a transaction with inner transaction rolls back___

When a transaction is defined within another transaction, the parent transaction can handle inner transaction failures.

```javascript
const {startTransaction} = require('core-transaction');

const promise = startTransaction({
      onCommit: () => { 
          console.info('This is executed after main transaction has committed');
      }
 })
.then((transaction) => {
    runInnerTransaction(transaction));
    transaction.rollback();
})
.catch(() => console.info('it is rolled back'))


function runInnerTransaction(parentTransaction)
    return parentTransaction.startInner({
        onCommit: (result) => { 
            console.info('This message will never show, since the main transaction has rolled back');
        }
        onRollback: () => { 
            console.info('This also is executed after main transaction has rolled back');
        }
    })
    .then(() => service.update(transaction,args))
    .then(() => console.info('it is partially committed, but final commit only happens if the main transaction commits'))
    .catch(() => console.info('it is not executed, since the main transaction failed, not the inner one'))
}
```

## Defining the implementation 
The default implementation has no effect. The commit and rollback code needs implementing.
An implementation class must be provided before using transaction

Example of setting the default implementation class

```javascript
const {setTransactionImplementationClass, getCoreTransactionClass} = require('core-transaction');

class TransactionImplementation extends getCoreTransactionClass() {
    constructor(parentTransaction, options) {
        super(parentTransaction, {
            processBegin: () => { 
                // start the main transaction
            },
            processCommit: () => { 
                // commit the main transaction
            },
            processRollback: () => { 
                // rollback the main transaction
            },
            // inner transaction might also be implemented if the resource support it
            processInnerBegin: _.noop,
            processInnerCommit: _.noop,
            processInnerRollback: _.noop
        },
        options);
    }

    executeSomething(params) {
        
        // return a promise under this transaction
    }
}

setTransactionImplementationClass(TransactionImplementation);
```

All methods added to the implementation class will be accessible from the transaction handler.

In the above implTransactionImplementation example, the executeSomething method should be related to the resource this class is providing transaction support for.

In a db implementation, processBegin implementation would start the transaction and store the db client, and the execute something would use the client to access the db.


```javascript
const {startTransaction} = require('core-transaction');

startTransaction()
    .then((transaction) => transaction.executeSomething(params))
```

## API

___setTransactionImplementationClass(class)___

class is the class to implement the begin, commit and rollback.


___startTransaction(options)___

Options: 

- onCommit callback is executed after the transaction commits.

- onRollback callback is executed after the transaction rollbacks.

- implementationClass is the implementation class that will be used instead of the configured class

Returns a transaction promise object.

- The 'then' of the promise provide access to the transaction handler.

___reUseOrCreateTransaction(parentTransaction, options)__

Options: 

- onCommit callback is executed after the transaction commits.

- onRollback callback is executed after the transaction rollbacks.

- implementationClass is the implementation class that will be used instead of the configured class

Returns a transaction promise object.

- The 'then' of the promise provide access to the transaction handler.


___defineTransaction (requirements, parentTransaction, options)___

Requirements : USE, NEW, REUSE_OR_NEW

Options: 

- onCommit callback is executed after the transaction commits.

- onRollback callback is executed after the transaction rollbacks.

- implementationClass is the implementation class that will be used instead of the configured class

Returns a transaction promise object.

- The 'then' of the promise provide access to the transaction handler.


___Transaction Promise Object___

- then((transaction) => ...) returns a promise and receives the transaction code to execute

- execute((transaction) => ...) Returns a promise. This is the same as then function

___Transaction Handler Object___

- startInner(options) 

  Options:
  - onCommit callback is executed after the transaction commits.
  - onRollback callback is executed after the transaction rollbacks.
  
  returns an inner transaction promise object.

- rollback() 

    rollback the transaction


## FUTURE IMPROVEMENTS
- XA transaction support and the ability to provide different inner transaction implementation class
- Provides git repository links to existing implementations, ex: Postgres.

