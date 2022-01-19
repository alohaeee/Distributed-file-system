import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import yaml from 'js-yaml';
import fetch from 'node-fetch';

// Список узлов
let peers: Array<string> = []
console.log("Reading peers from peers.yaml file");
try {
  peers = yaml.load(fs.readFileSync('./peers.yaml', 'utf8')) as Array<string>;
  console.log(peers);
} catch (e) {
  console.log(e);
}

// константы
const port = 8079;
const host = '0.0.0.0';

// приложение
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json())


function GetFullfiledPromises<T>(settled: PromiseSettledResult<T>[]) {
  let rs: T[] = settled.filter((v) => v.status === "fulfilled").map((v): T => {
    let s = v as PromiseFulfilledResult<T>;
    return s.value;
  });
  return rs;
}

async function PingPeer(peer: string){
  return {peer: peer, response: await fetch(`http://${peer}:8080/services`, {timeout: 500})}
}
/**
 * Посылает всем узлам проверяющее сообщение.
 * @return После ответа возвращает список активных узлов.
 */
app.get('/', async (req, res) => {
  console.log("Check for services");
  try {
    let promises : any[] = [];
    for (const peer in peers) {
      if (peer != req.query['from']){
        promises.push(PingPeer(peers[peer]));
      }
    }
    let prs: PromiseSettledResult<any>[] = await Promise.allSettled(promises);
    
    let results = await GetFullfiledPromises(prs);
    console.log(results);

    let response : string[] = [];
    for (let s in results){
      if (results[s].response.ok){
        response.push(results[s].peer);
      }
    }
    console.log(`Response: ${response}`);
    res.send(JSON.stringify(response));
  }
  catch (error) {
    console.error(error);
    res.statusCode = 400;
    res.send("Something goes wrong");
  }
});

console.log(`Running on http://${host}:${port}`);
app.listen(port, host);
