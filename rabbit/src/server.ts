import express from 'express';
import bodyParser from 'body-parser';
import multer from 'multer';
import fs from 'fs';
import { assert } from 'console';
import amqp from "amqplib";
import config, { ID } from './config';


/**
 * По топику на каждый узел, который будет хранилищем сообщений к конкретному узлу.
 * webjs0, webjs1, ... Сюда шлём ответы на запросы в основном
 * 
 * Топик общих сообщений - all. Так же для этого топика делаем разные группы -> туда посылаем, кто имеет файлы, репликацию и т.д.
 * 
 * I вариант
 * Methods:
 * Get(filename) - Посылает файл, если он имеется у узла. Шлём запрос в all с текущей ноды. Ноды отвечают в топика запрашивающего узла.
 * Add(filename) - Добавляем файл локально. Кидаем в топик repl просьбу зареплицировать файл. Партиций должны быть столько, сколько максимальное кол-во узлов в сети.
 *  Далее потребитель читает сообщение. И 
 * Replace(filename) - Замена файла. Кидаем в all 
 * Delete(fileame) - Кидаем в all, все потребители стараются удалить файл.
 */


if (!fs.existsSync(config.CONTENT_DIR)) {
  fs.mkdirSync(config.CONTENT_DIR);
}

function GetPath(filename: string): string {
  // FIXME: path.join?
  return `${config.CONTENT_DIR}/${filename}`;
}
let Config =
{
  RequestGroup: `RequestGroup${ID}`,
  RequestTopic: `RequestTopic`,
  ReplyTopic: `ReplyTopic`,
  ReplyGroup: `ReplyGroup${ID}`,
  ReplicateFileTopic: "ReplicateFileTopic",
  ReplicateFileGroup1: "ReplicateFileGroup1",
  ReplicateFileGroup2: "ReplicateFileGroup2",
}

class RabbitMQConfig {
  static host = "rabbit";
  static ip = `amqp://${RabbitMQConfig.host}`;
  static jobsQueue = "fs-queue";
  static maxNodeJobsCount = 10;
}

async function Run() {
  let connection = await amqp.connect(RabbitMQConfig.ip);

  let serviceChannel = await connection.createChannel();




  //connection.createChannel();

  // const producer = kafka.producer()
  // producer.connect()

  // const consumer = kafka.consumer({ groupId: Config.ReplyGroup })

  // consumer.connect()
  // consumer.subscribe({ topic: Config.ReplyTopic })

  function generateCorrelationId() {
    return Math.random().toString() + Math.random().toString() + Math.random().toString();
  }

  class Requester {
    StoreReply(correlationId: string, message: any) {
      if (this.requestList[correlationId] === undefined) {
        return false;
      }
      console.log(`Store reply: ${JSON.stringify(message)}`);
      this.requestList[correlationId].push(message);
      return true;
    }

    async Request(method: string, params: any, topic = Config.RequestTopic, tm: number = 2000): Promise<any[]> {
      const message_id: string = generateCorrelationId();
      this.requestList[message_id] = [];

      const ex = 'Own'
      // Declare the exchange
      await serviceChannel.assertExchange(ex, 'fanout')
      serviceChannel.publish(ex, '', Buffer.from(JSON.stringify({ method: method, params: params })),
        { correlationId: message_id });


      return new Promise<any[]>(async (resolve, reject) => {
        setInterval(
          () => {
            const requestedData = this.requestList[message_id];
            if (requestedData != undefined) {
              if (requestedData.length === 0) {
                reject("Timeout");
              }
              resolve(requestedData);
              delete this.requestList[message_id];

            }
            else {
              assert("requestedData is undefined");
              reject([]);
            }
          },
          tm);
      });
    }

    private requestList: { [id: string]: any[] } = {};
  };

  let requester = new Requester();

  console.log("&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&");

  console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  // приложение
  const app = express();
  app.use(bodyParser.urlencoded({ extended: true }));
  app.use(bodyParser.json())

  const memoryStorage = multer.memoryStorage();
  const memoryUpload = multer({ storage: memoryStorage });
  // Реквест якорю о текущих работающих узлах.

  app.get('/', (req, res) => {
    res.sendFile(__dirname + "/index.html");
  });



  /**
   * Ответ на запрос от якоря для определения узлов
   * @return 200 если инстанс готов к работе
   */
  app.get('/services', (req, res) => {
    console.log("Succes on check availebility of service");
    res.send();
  })

  interface BaseContentParams {
    filename: string
  }

  async function DeleteContent(params: BaseContentParams) {
    console.log(`DeleteContent ${params.filename}`);
    try {
      if (fs.existsSync(GetPath(params.filename))) {
        await fs.promises.unlink(GetPath(params.filename));
        return { "deleted": true };
      }
      else {
        return { "deleted": false };
      }

    }
    catch (err) {
      return Promise.reject(err);
    }
  }
  interface UploadContentParams extends BaseContentParams {
    buffer: Buffer,
  }
  async function UploadContent(params: UploadContentParams) {
    console.log(`UploadContent ${params.filename}`)
    try {
      await fs.promises.writeFile(GetPath(params.filename), params.buffer);
      return { "upload": true };
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async function ContentExists(params: BaseContentParams) {
    console.log(`ContentExists ${params.filename}`);
    return { exists: fs.existsSync(GetPath(params.filename)) }
  }

  async function GetContent(params: BaseContentParams) {
    console.log(`GetContent ${params.filename}`);
    try {
      if (fs.existsSync(GetPath(params.filename))) {
        let buffer = await fs.promises.readFile(GetPath(params.filename))
        return { filename: params.filename, content: buffer.toString() };
      }
      throw Error(`No such file ${params.filename}`);

    }
    catch (err) {
      return Promise.reject(err);
    }
  }



  async function CallMethod(method: string, params: any) {
    try {
      switch (method) {
        case "GetContent":
          return GetContent(params as BaseContentParams);
        case "UploadContent":
          return UploadContent(params as UploadContentParams);
        case "GetContent":
          return GetContent(params as BaseContentParams);
        case "ContentExists":
          return ContentExists(params as BaseContentParams);
        case "DeleteContent":
          return DeleteContent(params as BaseContentParams);
        default:
          throw (`Unknow method ${method}`)
      }
    }
    catch (err) {
      throw err;
    }

  }
  async function ContentNodeAppRun() {
    const queueId = `Owns${config.ID}`;
    const ex = 'Own'
    // Declare the exchange
    await serviceChannel.assertExchange(ex, 'fanout')
    await serviceChannel.assertQueue(queueId, { durable: false} );
    await serviceChannel.bindQueue(queueId, ex, '')
    await serviceChannel.consume(queueId, async (message) => {
      console.log("GOT MESSAGE");
      if (message) {
        if (message.properties.correlationId) {
          let correlationId = message.properties.correlationId;
          try{
            let msg = JSON.parse(message.content.toString());
            let result = await CallMethod(msg.method, msg.params) as any;
            //await serviceChannel.assertQueue(Config.ReplyTopic);
            await serviceChannel.sendToQueue(Config.ReplyTopic, Buffer.from(JSON.stringify({ reply: result })), { correlationId: correlationId });
          }
          catch(err){
            console.log(err);
            //await serviceChannel.assertQueue(Config.ReplyTopic);
            await serviceChannel.sendToQueue(Config.ReplyTopic, Buffer.from(JSON.stringify({ error: err })), { correlationId: correlationId });
          }
        }
        serviceChannel.ack(message);
      }
     
    });
  }


  /**
   * @param req.query.filename - имя файла
   * @param req.query.repl - надо ли выполнить поиск на других нодах
   * @param req.query.download - надо ли скачивать файл
   * @param req.query.locked? - надо ли блокировать файл.
   * @returns Файл, если он был найден, иначе 400.
   */
  app.get('/content', async (req, res) => {
    console.log(`Get file with name: ${JSON.stringify(req.query)}`);

    try {
      const params = {
        filename: req.query["filename"] as string,
      };
      let results = await requester.Request("GetContent", params);
      for (let i in results) {
        let result = results[i];
        if (result.reply)
        {
          if (result.reply.content != undefined) {
            res.send(result);
            return;
          }
        }
        
      }
      res.status(400).send(`Can't find file ${params.filename}`);
    }
    catch (error) {
      console.error(error);
      res.status(400).send(`Error: ${error}`);
    }
  });


  /**
   * Только для multipart/form-data запросов.
   * @param req.body.uploadFile - файл в бинарном формате
   * @param req.body.repl - надо ли зареплицировать файл на другую ноду
   * @returns Имя файла, если он был найден, иначе 400.
  */
  app.post('/content', memoryUpload.single("uploadFile"), async (req, res) => {
    console.log(`File uploading. body: ${JSON.stringify(req.body)}; files: ${JSON.stringify(req.file)}`)
    try {
      if (req.file) {
        const params = {
          filename: req.file.originalname,
          buffer: req.file.buffer,
        };
        let results = await requester.Request("UploadContent", params, Config.ReplicateFileTopic);
        for (let i in results) {
          let result = results[i];
          console.log(result);
          if (result.reply.upload === true) {
            res.send(`Файл загружен ${params.filename}`);
            return;
          }
        }
        throw Error("Cant upload file");
      }
      else {
        throw Error("Empty file");
      }
    }
    catch (error) {
      console.error(error);
      res.status(400);
      res.send(error);
    }
  });
  /**
   * @param req.body.filename - имя файла
   * @param req.body.repl - надо ли запросить удаление на других нодах
   * @returns Имя файла, если он был удалён, иначе 400.
   */
  app.delete('/content', async (req, res) => {
    console.log(`Delete content: ${JSON.stringify(req.body)}`);
    try {
      const params = {
        filename: req.body["filename"],
      };
      let results = await requester.Request("DeleteContent", params);
      for (let i in results) {
        let result = results[i];
        if (result.reply.deleted === true) {
          res.send(`File was deleted ${params.filename}`);
          return;
        }
      }
      throw Error(`Cant delete file ${params.filename}`);
    }
    catch (error) {
      res.status(400);
      console.log(error);
      res.send(error);
    }
  });
  console.log(`Running on http://${config.host}:${config.port} with ${config.ID}`);
  app.listen(config.port, config.host);
  if (Number(config.ID) === 0)
  {
    await serviceChannel.assertQueue(Config.ReplyTopic);
    await serviceChannel.consume(Config.ReplyTopic, async (message) => {
      try {
        if (message) {
          if (message.properties.correlationId) {
            let correlationId = message.properties.correlationId;
            if (correlationId != undefined) {
              let msg = JSON.parse(message.content.toString());
              requester.StoreReply(correlationId.toString(), msg);
            }
          }
        }
      }
      catch (err) {
        console.error(err);
      }
    });
  }
  

  await ContentNodeAppRun();
}
Run();