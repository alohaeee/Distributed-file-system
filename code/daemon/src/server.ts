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


/**
 * Посылает всем узлам проверяющее сообщение.
 * @return После ответа возвращает список активных узлов.
 */
app.get('/', async (req, res) => {
  console.log("Check for services");
  try {
    let promises : any[] = [];
    let indexies : number[] = [];
    for (const peer in peers) {
      if (peer != req.query['from']){
        promises.push(fetch(`http://${peers[peer]}:8080/services`));
        indexies.push(Number(peer));
      }
    }

    let results = await Promise.all(promises);
    console.log(results);

    let response : string[] = [];
    for (let s in results){
      if (results[s].ok){
        let peerIndex : number = indexies[s];
        response.push(peers[peerIndex]);
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
