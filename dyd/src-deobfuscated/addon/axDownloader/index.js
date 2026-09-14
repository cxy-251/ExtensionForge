'use strict';
const axiosBase=require("axios"),{
  HttpsProxyAgent
}=require("https-proxy-agent"),fs=require('fs'),path=require("path"),common=require("../../common");
class AxDownloaderAddon{
  constructor(){
    this.isInterrupt=![];
  }async.download(_0x2378db,_0x33d2f6){
    if(this.isInterrupt)this.isInterrupt=![];
    if(Array.isArray(_0x2378db))return new Promise(async(_0x2f6b84,_0x4bbbc4)=>{
      try{
        for(let _0x526b32=0;
        _0x526b32<_0x2378db.length;
        _0x526b32++){
          if(this.isInterrupt){
            _0x4bbbc4();
            return;
          }let _0x565ce5=path.join(_0x33d2f6.outDir,_0x526b32+1+".jpg");
          if(typeof _0x33d2f6.nameFactory==="function")_0x565ce5=path.join(_0x33d2f6.outDir,_0x33d2f6.nameFactory(_0x526b32));
          const _0x3a887d=await this.download(_0x2378db[_0x526b32],{
            ..._0x33d2f6,'outPath':_0x565ce5,'onProgress':void 0,'skipDownloaded':!![]
          });
          if(typeof _0x33d2f6.onProgress==="function")_0x33d2f6.onProgress({
            'rate':parseInt(((_0x526b32+1)/_0x2378db.length*100).toString())
          });
          !_0x3a887d.isSkipDownloaded&&await common.sleep(100);
        }_0x2f6b84({
          'outDir':_0x33d2f6.outDir
        });
      }catch(_0x1e6684){
        _0x4bbbc4(_0x1e6684);
      }
    });
    if(!_0x2378db)return Promise.reject(new Error("url is empty"));
    return new Promise(async(_0x2c7c2a,_0x2f3b3f)=>{
      if(fs.existsSync(_0x33d2f6.outPath)&&_0x33d2f6.skipDownloaded){
        _0x2c7c2a({
          'outPath':_0x33d2f6.outPath,'isSkipDownloaded':_0x33d2f6.skipDownloaded
        });
        return;
      }const _0x443775=fs.createWriteStream(_0x33d2f6.outPath);
      try{
        const {
          data:_0x377dcf,headers:_0x5a1bfe
        }=await axiosBase.get(_0x2378db,{
          'responseType':"stream",'httpAgent':_0x33d2f6.proxy?new HttpsProxyAgent("http://"+_0x33d2f6.proxy.host+':'+_0x33d2f6.proxy.port):void 0,'httpsAgent':_0x33d2f6.proxy?new HttpsProxyAgent("http://"+_0x33d2f6.proxy.host+':'+_0x33d2f6.proxy.port):void 0,'headers':_0x33d2f6.headers||void 0,'timeout':_0x33d2f6.timeout||15000,'cancelToken':new axiosBase[("CancelToken")](_0xa2663c=>this.cancelToken=_0xa2663c)
        });
        if(typeof _0x33d2f6.onProgress==="function"){
          let _0x5f2265=parseInt(_0x5a1bfe["content-length"]),_0x3cdfe3=0;
          _0x377dcf['on']("data",_0xbc8b48=>{
            _0x443775.write(_0xbc8b48),_0x3cdfe3+=_0xbc8b48.length,_0x33d2f6.onProgress({
              'rate':parseInt((_0x3cdfe3/_0x5f2265*100).toString())
            });
          });
        }else _0x377dcf['on']("data",_0x53a6cc=>{
          _0x443775.write(_0x53a6cc);
        });
        _0x377dcf['on']("end",()=>{
          _0x443775.end(),_0x2c7c2a({
            'outPath':_0x33d2f6.outPath
          });
        }),_0x377dcf['on']("error",_0x517240=>{
          _0x443775.end(),common.deleteFile(_0x33d2f6.outPath),_0x2f3b3f(_0x517240);
        });
      }catch(_0x45ca29){
        _0x443775.end(),common.deleteFile(_0x33d2f6.outPath),_0x2f3b3f(_0x45ca29);
      }
    });
  }.cancel(){
    this.isInterrupt=!![];
    try{
      this.cancelToken();
    }catch(_0x5456bb){
    }
  }
}AxDownloaderAddon.toString=()=>"[class AxDownloaderAddon]",module.exports=AxDownloaderAddon;
