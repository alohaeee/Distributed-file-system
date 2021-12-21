import express from 'express';
import bodyParser from 'body-parser';
import multer from 'multer';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';
import { Response } from 'node-fetch';
import { assert } from 'console';
import { EventEmitter } from "events";
import { JSONRPCServer } from 'json-rpc-2.0';
import crypto, { Hash } from 'crypto';
import { Kafka } from 'kafkajs';

// TODO:
// + Перезапись файлов на всех узлах. 
// Если узел умер, и потом вернулся, надо актуализировать файлы
// +Рандомить время на запрос о наличии файла.
// Для кафки: Отдельный узел - брокер для очередей.

/*
 * Простейший механизм для транзакции. Не сохраняет последовательность операций над объектом!! 
 * Но обеспечивает целостность Get запроса на объект.
 */
class LockTransaction {
  LockWith(filename: string, lock: boolean) {
    if (lock == true) {
      this.Lock(filename);
    }
    else {
      this.Unlock(filename);
    }
  }
  Lock(filename: string) {
    console.log("lock file: " + filename);
    if (this.files[filename] == null) {
      this.files[filename] = 1;
    }
    else {
      this.files[filename] += 1;
    }
  }
  Unlock(filename: string) {
    console.log("unlock file: " + filename);
    assert(this.files[filename] != null, "Unlock non locked file");
    if (this.files[filename] > 1) {
      this.files[filename] -= 1;
    }
    else {
      this.emmiter.emit("unlock", filename);
      delete this.files[filename];
    }
  }
  LockCount(filename: string): number {
    if (this.files[filename] == null) {
      return 0;
    }
    else {
      return this.files[filename];
    }
  }
  emmiter: EventEmitter = new EventEmitter();
  private files: { [filename: string]: number } = {};
};
let lock = new LockTransaction();

// Удаление файла с локом.
async function DeleteLockedFile(path: string): Promise<boolean> {
  let lockedOnExecute = lock.LockCount(path) != 0;
  return new Promise<boolean>(async (resolve, reject) => {
    if (lockedOnExecute) {
      let handler = async (filename: string) => {
        if (path === filename) {
          let deleted = false;
          if (fs.existsSync(path)) {
            await fsPromises.unlink(path);
            deleted = true;
          }
          lock.emmiter.removeListener("unlock", handler);
          resolve(deleted);
        }
      };
      lock.emmiter.addListener("unlock", handler);
    }
    else {
      if (fs.existsSync(path)) {
        await fsPromises.unlink(path);
        resolve(true);
      }
      else {
        resolve(false);
      }

    }
  });
}


interface TypedRequestBody<T> extends Express.Request {
  body: T
}

// Хелпер методы для массива
function Sample<T>(arr: Array<T>): T {
  return arr[Math.floor(Math.random() * arr.length)];
};

async function GetFileHash(path: string) {
  return new Promise((resolve, reject) => {

    let streamPipe = fs.createReadStream(path).pipe(crypto.createHash('sha1').setEncoding('hex'))
    streamPipe.on('finish', function () {
      console.log(`Hash for ${path} ${streamPipe.read()}`)
      resolve(streamPipe.read())
    })
  });

}



let peers: string[] = [];
// константы
const port = 8080;
const host = '0.0.0.0';


const ID = process.env.ID;
// Обращаемся к отдельной папке на хосте
const CONTENT_DIR = "./uploads/" + ID;

if (!fs.existsSync(CONTENT_DIR)) {
  fs.mkdirSync(CONTENT_DIR);
}

const DAEMON_URL = ID === undefined ? "http://0.0.0.0:8079" : "http://daemonjs:8079";
console.log(`DAEMON_URL: ${DAEMON_URL}`);

function GetBool(str: string, def: boolean = true): boolean {
  try {
    return str == null ? def : (JSON.parse(str) as boolean);
  }
  catch {
    return false;
  }
}
function GetFullfiledPromises<T>(settled: PromiseSettledResult<T>[]) {
  let rs: T[] = settled.filter((v) => v.status === "fulfilled").map((v): T => {
    let s = v as PromiseFulfilledResult<T>;
    return s.value;
  });
  return rs;
}
function GetPath(filename: string): string {
  // FIXME: path.join?
  return `${CONTENT_DIR}/${filename}`;
}
function GetUrlForPeer(peer: string): string {
  return `http://${peer}:${port}`;
}
async function GetPeers() {
  console.log("In get peers method")

  let result = await fetch(`${DAEMON_URL}/?from=${ID}`);
  let json = await result.json();

  if (result.ok) {
    console.log("Get peers result: " + JSON.stringify(json));
    peers = json as string[];
  }
}


interface UploadParams {
  filename: string
  buffer: Buffer
  repl: boolean
};

interface GetParams {
  filename: string,
  repl: boolean,
  download: boolean,
  locked: boolean,
  hash: Hash
};

interface DeleteParams {
  filename: string,
  repl: boolean
};

type GetReqParam = string | Buffer | undefined | [GetReqParam | string];

abstract class AppApiInterface {
  abstract GetContentRequest(peer: string, data: Partial<GetParams>): Promise<Response>;
  abstract UploadContentRequest(peer: string, data: Partial<UploadParams>): Promise<Response>;
  abstract DeleteContentRequest(peer: string, data: Partial<DeleteParams>): Promise<Response>;

  UploadFile(path: string, buffer: Buffer): Promise<void> {
    return fsPromises.writeFile(path, buffer);
  }

  async UploadContentResponse(data: Partial<UploadParams>): Promise<string> {
    console.log(`UploadContentResponce: ${JSON.stringify(data)}`);

    if (data.filename && data.buffer) {
      const filePath = GetPath(data.filename)
      // Запускаем задание на запись файла.
      let filePromise = this.UploadFile(filePath, data.buffer);
      data.repl = data.repl == undefined ? true : data.repl;
      if (data.repl == true) {
        console.log("Replicating file root");

        // Дожидаемся информации о узлах.
        await GetPeers();

        // Дождёмся загрузки файла.
        await filePromise;
        if (!fs.existsSync(filePath)) {
          throw Error("Intrnal error: File doesn't exists");
        }



        // Проверим наличиее контента на других узлах
        const getParam: Partial<GetParams> = {
          filename: data.filename,
          repl: false,
          download: false
        };

        // ----- TODO: Этот код можно было бы вынести в функцию с callback. Рефакторинг
        let getResPromises: any[] = [];
        for (const i in peers) {
          const peer = peers[i];
          getResPromises.push(this.GetContentRequest(GetUrlForPeer(peer), getParam));
        }
        let prs: PromiseSettledResult<Response>[] = await Promise.allSettled(getResPromises);
        let rs: Response[] = GetFullfiledPromises(prs);

        let peersRewriteIndexies: number[] = [];
        for (let i in rs) {
          let r = rs[i]
          if (r.ok) {
            let filename = await this.ParseGetContentRequest(r, getParam);
            if (filename === data.filename) {
              peersRewriteIndexies.push(Number(i));
            }
          }
        }
        // ------------

        // Реплицировать файл ещё раз не надо, словим цикл.
        data.repl = false;

        if (peersRewriteIndexies.length > 0) {
          // -----TODO: рефакторинг
          let uploadPromises: any[] = [];
          for (let i in peersRewriteIndexies) {
            let peerI = peersRewriteIndexies[i];
            let peer = peers[peerI];
            uploadPromises.push(this.UploadContentRequest(GetUrlForPeer(peer), data));
          }
          let prs: PromiseSettledResult<Response>[] = await Promise.allSettled(uploadPromises);
          let rs: Response[] = GetFullfiledPromises(prs);

          for (let i in rs) {
            let r = rs[i];
            if (r.ok) {
              let filename = await this.ParseGetContentRequest(r, data);
              if (filename === data.filename) {
                console.log(`Update content ${data.filename} on node: ${peers[peersRewriteIndexies[i]]}`)
              }
            }
          }
          // -------

        }
        else {
          // Реплицируем на рандомный узел.
          let peer = Sample(peers);
          if (peer === undefined) {
            throw Error("Intrenal error: Empty peer");
          }

          const result = await this.UploadContentRequest(GetUrlForPeer(peer), data);
          // TODO: добавить в res результат реплицирования
          if (result.ok) {
            if (await this.ParseGetContentRequest(result, data) === data.filename) {
              console.log(`Succes upload to other node: ${peer}`);
            }
            else {
              console.error(`Error on repl file to node ${peer}`);
            }
          }
        }
      }
      // Дожидаемся загрузки файла.
      await filePromise;
      console.log(`Success upload file ${JSON.stringify(data.filename)}`);
      return data.filename;
    }
    else {
      throw Error("Empty file");
    }
  }
  abstract ParseGetContentRequest(res: Response, data: Partial<GetParams>): Promise<GetReqParam>;

  async SimulateTimerForResponse(res: Promise<Response>): Promise<[number, Response]> {
    let r = await res;
    return [Date.now(), r];
  }
  async SyncFile(path: string): Promise<void> {
    if (this.syncFiles) {
      let currentHash = GetFileHash(path);
      // let getResPromises: any[] = [];
      // for (const i in peers) {
      //   const peer = peers[i];
      //   getResPromises.push(Method(GetUrlForPeer(peer)), getParam));
      // }
      // let prs: PromiseSettledResult<Response>[] = await Promise.allSettled(getResPromises);
      // let rs: Response[] = GetFullfiledPromises(prs);

      // for (let i in rs) {
      //   let r = rs[i]
      //   if (r.ok) {
      //     let filename = await this.ParseGetContentRequest(r, getParam);
      //     if (filename === data.filename) {
      //       peersRewriteIndexies.push(Number(i));
      //     }
      //   }
      // }
    }

  }
  async GetContentResponse(data: Partial<GetParams>): Promise<GetReqParam> {
    console.log(`GetContentResponse: ${JSON.stringify(data)}`);
    try {
      if (data.filename) {
        data.repl = data.repl == undefined ? true : data.repl;
        data.download = data.download == undefined ? true : data.download;
        const path = GetPath(data.filename);
        if (fs.existsSync(path)) {
          console.log(`File founded ${path}`);
          if (data.download == true) {
            await this.SyncFile(path);
            console.log(`Download ${path}`);
            return fsPromises.readFile(path);
          }
          else {
            console.log(`Send ${path}`);
            return data.filename;
          }
        }
        else if (data.repl === true) {
          await GetPeers();
          // Начинаем транзакцию...
          let getResPromises: any[] = [];
          const getParam: Partial<GetParams> = {
            filename: data.filename,
            repl: false,
            download: false
          };

          for (const i in peers) {
            const peer = peers[i];
            getResPromises.push(this.SimulateTimerForResponse(this.GetContentRequest(GetUrlForPeer(peer), getParam)));
          }
          const currentTime = Date.now();
          console.log(`[GetContentResponse] Current time: ${currentTime}`);
          let prs: PromiseSettledResult<any>[] = await Promise.allSettled(getResPromises);
          let rs: [number, Response][] = GetFullfiledPromises(prs);

          let fastesPeerIndex: number | undefined = undefined;
          let cancelTranscationIndexies: number[] = [];
          console.log(rs);

          let delta = currentTime;
          for (const i in rs) {
            const r: Response = rs[i][1];
            const time = rs[i][0];
            if (r.ok === true) {
              let filename: GetReqParam = await this.ParseGetContentRequest(r, getParam);
              console.log(`[GetContentResponse] Filename: ${JSON.stringify(filename)} Time: ${time}`);
              if (filename) {
                if (filename === data.filename) {
                  let curDelta = time - currentTime;
                  // Выбираем самый быстрый узел
                  if (delta > curDelta) {
                    console.log(`[GetContentResponse] Choose fastes peer with delay ${curDelta}: ${peers[i]}`);
                    fastesPeerIndex = Number(i);
                    delta = curDelta;
                  }

                  cancelTranscationIndexies.push(Number(i));
                  console.log(`${peers[i]} has file: ${data.filename}`)
                }
              }

            }
          }
          getParam.locked = false;
          let cancelTranscationPromises: any[] = [];
          for (let i in cancelTranscationIndexies) {
            if (cancelTranscationIndexies[i] != fastesPeerIndex) {
              cancelTranscationPromises.push(this.GetContentRequest(GetUrlForPeer(peers[cancelTranscationIndexies[i]]), getParam))
            }
          }
          if (fastesPeerIndex === undefined) {
            console.log("Empty fastesPeerIndex");
            throw Error("Can't find file: " + data.filename);
          }

          const fastesPeer = peers[fastesPeerIndex];
          console.log(`fastes peer: ${fastesPeer}`);
          getParam.download = true;
          let fileDownloadRes = await this.GetContentRequest(GetUrlForPeer(fastesPeer), getParam);
          let result = await this.ParseGetContentRequest(fileDownloadRes, getParam);
          if (result == undefined) {
            throw Error("Cant't parse data file: " + data.filename);
          }

          await Promise.all(cancelTranscationPromises);

          return result;

        }
        else {
          throw Error("Can't find file with name: " + data.filename);
        }
      }
      else {
        throw Error("Can't find file with name: " + data.filename);
      }
    }
    catch (error) {
      throw (error)
    }
  }

  async DeleteContentResponse(data: Partial<DeleteParams>): Promise<string> {
    console.log(`DeleteContentResponse: ${JSON.stringify(data)}`);
    if (data.filename) {
      data.repl = data.repl == undefined ? true : data.repl;
      let path = GetPath(data.filename);
      // Флаг - костыль
      let delFlag: boolean = false;
      // Запустим асинхронный таск на удаление файла с этого инстанса. 
      let promiseDel: Promise<boolean> = DeleteLockedFile(path);
      // Проверим другие узлы.
      if (data.repl === true) {

        await GetPeers();
        data.repl = false;
        let delResPromises: any[] = [];

        for (const i in peers) {
          let peer = peers[i];

          delResPromises.push(this.DeleteContentRequest(GetUrlForPeer(peer), data));
        }
        let delRes: Response[] = await Promise.all(delResPromises);
        for (const i in delRes) {
          let del = delRes[i];
          if (del.ok) {
            if (await this.ParseGetContentRequest(del, data)) {
              delFlag = true;
              console.log(`Delete file: ${data.filename} in peer: ${peers[i]}`);
            }

          }
        }
      }
      delFlag = delFlag || await promiseDel;
      if (delFlag) {
        return data.filename;
      }
      else {
        throw Error("Cant find file with name: " + data.filename);
      }
    }
    else {
      throw Error("Empty filename");
    }
  }
  private syncFiles: boolean = true;
};

const RPCServer = new JSONRPCServer();

class RPCApi extends AppApiInterface {
  UploadContentRequest(url: string, data: Partial<UploadParams>): Promise<Response> {
    return this.RequestRpc(url, "uploadContent", data);
  }
  GetContentRequest(url: string, data: Partial<GetParams>): Promise<Response> {
    return this.RequestRpc(url, "getContent", data);
  }
  async DeleteContentRequest(url: string, data: Partial<DeleteParams>): Promise<Response> {
    return this.RequestRpc(url, "deleteContent", data);
  }
  async ParseGetContentRequest(res: Response, data: Partial<GetParams>): Promise<GetReqParam> {
    console.log("ParseRpc");
    let json = await res.json();
    let result = json["result"];
    return result;
  }

  private async RequestRpc(url: string, method: string, params: object): Promise<Response> {
    return fetch(`${url}/content-rpc`, {
      headers:
        { 'Content-Type': 'application/json' }
      , body: JSON.stringify({ "jsonrpc": "2.0", "method": method, "params": params, "id": this.createID() }), method: 'POST'
    })
  }

  private nextId: number = 0;
  private createID = () => this.nextId++;
};

const rpcHelper = new RPCApi();

class RestApi extends AppApiInterface {
  async UploadContentRequest(url: string, data: Partial<UploadParams>): Promise<Response> {
    const form = new FormData();

    form.append('uploadFile', data.buffer, {
      filename: JSON.stringify(data.filename),
    });
    form.append('repl', JSON.stringify(data.repl));

    return fetch(`${url}/content`, {
      method: 'POST', body: form
    });
  }
  async DeleteContentRequest(url: string, data: Partial<DeleteParams>): Promise<Response> {
    return fetch(`${url}/content`, {
      headers:
        { 'Content-Type': 'application/json' }
      , body: JSON.stringify(data), method: 'DELETE'
    });
  }

  async ParseGetContentRequest(res: Response, data: Partial<GetParams>): Promise<GetReqParam> {
    if (data.download == true) {
      return res.buffer();
    }
    return res.text();
  }

  GetContentRequest(peer: string, data: Partial<GetParams>): Promise<Response> {
    const object = Object(data);
    const params: string = new URLSearchParams(object).toString()
    return fetch(`${peer}/content?${params}`);
  }
};


// приложение
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json())


const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, CONTENT_DIR);
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  }
});

const upload = multer({ storage: storage });

const memoryStorage = multer.memoryStorage();
const memoryUpload = multer({ storage: memoryStorage });
const restHelper = new RestApi();


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
    const data: Partial<GetParams> = {
      filename: req.query["filename"] as string,
      repl: GetBool(req.query["repl"] as string),
      download: GetBool(req.query["download"] as string, false)
    };
    let result = await restHelper.GetContentResponse(data);
    res.send(result);
  }
  catch (error) {
    res.status(400);
    console.log(error);
    res.send(error);
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
      const params: Partial<UploadParams> = {
        filename: req.file.originalname,
        repl: req.body["repl"],
        buffer: req.file.buffer,
      };
      let file: string = await restHelper.UploadContentResponse(params)
      res.send(file);
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
app.delete('/content', async (req: TypedRequestBody<DeleteParams>, res) => {
  console.log(`Delete content: ${JSON.stringify(req.body)}`);
  try {
    let result = await restHelper.DeleteContentResponse(req.body);
    res.send(result);
  }
  catch (error) {
    res.status(400);
    console.log(error);
    res.send(error);
  }
});


/**
 * RPC
 */

RPCServer.addMethod('getContent', async (params) => {
  console.log("GetContent");
  let p = params as Partial<GetParams>;
  let result = await rpcHelper.GetContentResponse(p);
  if (result instanceof Buffer) {
    return result.toString();
  }
  return result;
});

RPCServer.addMethod('uploadContent', async (params): Promise<any> => {
  console.log("UploadContentRpc");
  let p = params as Partial<UploadParams>;
  let result = await rpcHelper.UploadContentResponse(p);
  return result;
});

RPCServer.addMethod('deleteContent', async (params): Promise<any> => {
  console.log("UploadContentRpc");
  let p = params as Partial<DeleteParams>;
  let result = await rpcHelper.DeleteContentResponse(p);
  return result;
});

app.post("/content-rpc", (req, res) => {
  console.log(`RPC request: ${JSON.stringify(req.body)}`)
  const jsonRPCRequest = req.body;
  // server.receive takes a JSON-RPC request and returns a promise of a JSON-RPC response.
  // It can also receive an array of requests, in which case it may return an array of responses.
  // Alternatively, you can use server.receiveJSON, which takes JSON string as is (in this case req.body).
  RPCServer.receive(jsonRPCRequest).then((jsonRPCResponse) => {
    if (jsonRPCResponse) {
      console.log(`Send RPC: ${JSON.stringify(jsonRPCResponse)}`)
      res.json(jsonRPCResponse);
    } else {
      // If response is absent, it was a JSON-RPC notification method.
      // Respond with no content status (204).
      res.sendStatus(204);
    }
  });
});



console.log(`Running on http://${host}:${port} with ${ID}`);
app.listen(port, host);


