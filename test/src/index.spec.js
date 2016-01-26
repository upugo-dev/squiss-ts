/*
 * Copyright (c) 2015 TechnologyAdvice
 */

import AWS from 'aws-sdk';
import Squiss from 'src/index';
import SQSStub from 'test/stubs/SQSStub';

let inst = null;
const origSQS = AWS.SQS;

describe('index', () => {
  afterEach(() => {
    if (inst) inst.stop();
    inst = null;
    AWS.SQS = origSQS;
  });
  describe('constructor', () => {
    it('creates a new Squiss instance', () => {
      inst = new Squiss({
        queueUrl: 'foo',
        unwrapSns: true,
        visibilityTimeout: 10
      });
      should.exist(inst);
    });
    it('fails if queue is not specified', () => {
      let errored = false;
      try {
        new Squiss();
      } catch (e) {
        should.exist(e);
        e.should.be.instanceOf(Error);
        errored = true;
      }
      errored.should.be.true;
    });
    it('provides a configured sqs client instance', () => {
      inst = new Squiss({
        queueUrl: 'foo',
        awsConfig: {
          region: 'us-east-1'
        }
      });
      inst.should.have.property('sqs');
      inst.sqs.should.be.an.Object;
      inst.sqs.config.region.should.equal('us-east-1');
    });
    it('retrieves the queueUrl when a queueName is supplied', (done) => {
      AWS.SQS = class SQS {
        getQueueUrl(params, cb) {
          params.QueueName.should.equal('foo');
          setImmediate(cb.bind(null, null, { QueueUrl: 'fooUrl' }));
        }
      };
      inst = new Squiss({ queueName: 'foo' });
      inst.on('ready', done);
    });
    it('retrieves the queueUrl from a different account', (done) => {
      AWS.SQS = class SQS {
        getQueueUrl(params, cb) {
          params.QueueName.should.equal('foo');
          params.QueueOwnerAWSAccountId.should.equal('bar');
          setImmediate(cb.bind(null, null, { QueueUrl: 'fooUrl' }));
        }
      };
      inst = new Squiss({
        queueName: 'foo',
        accountNumber: 'bar'
      });
      inst.on('ready', done);
    });
  });
  describe('Receiving', () => {
    it('waits to run until a queueUrl is retrieved', (done) => {
      AWS.SQS = class SQS {
        getQueueUrl(params, cb) {
          setImmediate(cb.bind(null, null, { QueueUrl: 'fooUrl' }));
        }
      };
      inst = new Squiss({ queueName: 'foo' });
      inst.sqs = new SQSStub(1);
      inst.start();
      inst.on('ready', () => {
        inst.on('message', () => done());
      });
    });
    it('reports the appropriate "running" status', () => {
      inst = new Squiss({ queueUrl: 'foo' });
      inst._getBatch = () => {};
      inst.running.should.be.false;
      inst.start();
      inst.running.should.be.true;
    });
    it('treats start() as idempotent', () => {
      inst = new Squiss({ queueUrl: 'foo' });
      inst._getBatch = () => {};
      inst.running.should.be.false;
      inst.start();
      inst.start();
      inst.running.should.be.true;
    });
    it('receives a batch of messages under the max', (done) => {
      let msgs = 0;
      inst = new Squiss({ queueUrl: 'foo' });
      inst.sqs = new SQSStub(5);
      inst.start();
      inst.on('message', () => msgs++);
      setImmediate(() => {
        msgs.should.equal(5);
        done();
      });
    });
    it('receives batches of messages', (done) => {
      let msgs = 0;
      inst = new Squiss({ queueUrl: 'foo' });
      inst.sqs = new SQSStub(15);
      inst.start();
      inst.on('message', () => msgs++);
      setImmediate(() => {
        msgs.should.equal(10);
        setImmediate(() => {
          msgs.should.equal(15);
          done();
        });
      });
    });
    it('receives batches of messages when maxInflight = receiveBatchSize', (done) => {
      let msgs = 0;
      inst = new Squiss({ queueUrl: 'foo', maxInFlight: 10, receiveBatchSize: 10 });
      inst.sqs = new SQSStub(15);
      inst.start();
      inst.on('message', (m) => {
        msgs++;
        m.del();
      });
      setImmediate(() => {
        msgs.should.equal(10);
        setImmediate(() => {
          msgs.should.equal(15);
          done();
        });
      });
    });
    it('receives no messages', (done) => {
      let msgs = 0;
      inst = new Squiss({ queueUrl: 'foo' });
      inst.sqs = new SQSStub(0, 0);
      inst.start();
      inst.on('message', () => msgs++);
      setTimeout(() => {
        msgs.should.equal(0);
        done();
      }, 5);
    });
    it('emits queueEmpty event with no messages', (done) => {
      let msgs = 0;
      inst = new Squiss({ queueUrl: 'foo' });
      inst.sqs = new SQSStub(0, 0);
      inst.start();
      inst.on('message', () => msgs++);
      inst.on('queueEmpty', () => {
        msgs.should.equal(0);
        inst.stop();
        done();
      });
    });
    it('observes the maxInFlight cap', (done) => {
      let msgs = 0;
      inst = new Squiss({ queueUrl: 'foo', maxInFlight: 10 });
      inst.sqs = new SQSStub(15);
      inst.start();
      inst.on('message', () => msgs++);
      setImmediate(() => {
        msgs.should.equal(10);
        setImmediate(() => {
          msgs.should.equal(10);
          done();
        });
      });
    });
    it('reports the correct number of inFlight messages', (done) => {
      let msgs = [];
      inst = new Squiss({ queueUrl: 'foo', deleteWaitMs: 0 });
      inst.sqs = new SQSStub(5);
      inst.start();
      inst.on('message', (msg) => msgs.push(msg));
      setImmediate(() => {
        inst.inFlight.should.equal(5);
        inst.deleteMessage(msgs.pop());
        inst.handledMessage();
        setImmediate(() => {
          inst.inFlight.should.equal(3);
          done();
        });
      });
    });
  });
  describe('Deleting', () => {
    it('deletes messages using internal API', (done) => {
      let msgs = [];
      inst = new Squiss({ queueUrl: 'foo', deleteWaitMs: 0 });
      inst.sqs = new SQSStub(5);
      sinon.spy(inst.sqs, 'deleteMessageBatch');
      inst.start();
      inst.on('message', (msg) => msgs.push(msg));
      setImmediate(() => {
        msgs.should.have.length(5);
        inst.deleteMessage(msgs.pop());
        setTimeout(() => {
          inst.sqs.deleteMessageBatch.should.be.calledOnce;
          done();
        }, 10);
      });
    });
    it('deletes messages using Message API', (done) => {
      let msgs = [];
      inst = new Squiss({ queueUrl: 'foo', deleteWaitMs: 0 });
      inst.sqs = new SQSStub(5);
      sinon.spy(inst.sqs, 'deleteMessageBatch');
      inst.start();
      inst.on('message', (msg) => msgs.push(msg));
      setImmediate(() => {
        msgs.should.have.length(5);
        msgs.pop().del();
        setTimeout(() => {
          inst.sqs.deleteMessageBatch.should.be.calledOnce;
          done();
        }, 10);
      });
    });
    it('deletes messages in batches', (done) => {
      let msgs = [];
      inst = new Squiss({ queueUrl: 'foo', deleteWaitMs: 10 });
      inst.sqs = new SQSStub(15);
      sinon.spy(inst.sqs, 'deleteMessageBatch');
      inst.start();
      inst.on('message', (msg) => msgs.push(msg));
      setTimeout(() => {
        inst.stop();
        msgs.forEach((msg) => msg.del());
        inst.sqs.deleteMessageBatch.should.be.calledOnce;
        setTimeout(() => {
          inst.sqs.deleteMessageBatch.should.be.calledTwice;
          done();
        }, 20);
      }, 5);
    });
    it('deletes immediately with batch size=1', (done) => {
      let msgs = [];
      inst = new Squiss({ queueUrl: 'foo', deleteBatchSize: 1 });
      inst.sqs = new SQSStub(1);
      sinon.spy(inst.sqs, 'deleteMessageBatch');
      inst.start();
      inst.on('message', (msg) => msgs.push(msg));
      setImmediate(() => {
        inst.stop();
        msgs[0].del();
        inst.sqs.deleteMessageBatch.should.be.calledOnce;
        done();
      });
    });
  });
  describe('Failures', () => {
    it('emits delError when a message fails to delete', (done) => {
      inst = new Squiss({ queueUrl: 'foo', deleteBatchSize: 1 });
      inst.sqs = new SQSStub(1);
      inst.on('delError', (fail) => {
        should.exist(fail);
        fail.should.be.an.Object;
        done();
      });
      inst.deleteMessage({
        raw: {
          MessageId: 'foo',
          ReceiptHandle: 'bar'
        }
      });
    });
    it('emits error when delete call fails', (done) => {
      inst = new Squiss({ queueUrl: 'foo', deleteBatchSize: 1 });
      inst.sqs = new SQSStub(1);
      inst.sqs.deleteMessageBatch = (params, cb) => {
        cb(new Error('test'));
      };
      inst.on('error', (err) => {
        should.exist(err);
        err.should.be.an.Error;
        done();
      });
      inst.deleteMessage({
        raw: {
          MessageId: 'foo',
          ReceiptHandle: 'bar'
        }
      });
    });
    it('emits error when receive call fails', (done) => {
      inst = new Squiss({ queueUrl: 'foo' });
      inst.sqs = new SQSStub(1);
      inst.sqs.receiveMessage = (params, cb) => {
        cb(new Error('test'));
      };
      inst.on('error', (err) => {
        should.exist(err);
        err.should.be.an.Error;
        done();
      });
      inst.start();
    });
    it('emits error when GetQueueURL call fails', (done) => {
      AWS.SQS = class SQS {
        getQueueUrl(params, cb) {
          setImmediate(cb.bind(null, new Error('test')));
        }
      };
      inst = new Squiss({ queueName: 'foo' });
      inst.on('error', (err) => {
        should.exist(err);
        err.should.be.an.Error;
        done();
      });
    });
  });
  describe('Testing', () => {
    it('allows queue URLs to be corrected to the endpoint hostname', (done) => {
      AWS.SQS = function() { return new SQSStub(1); };
      inst = new Squiss({ queueName: 'foo', correctQueueUrl: true });
      inst.sqs = new SQSStub(1);
      inst.on('ready', () => {
        inst._queueUrl.should.equal('http://foo.bar/queues/foo');
        done();
      });
    });
  });
});
